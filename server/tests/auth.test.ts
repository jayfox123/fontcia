import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { signupRateLimit, loginRateLimit } from '../src/routes/auth';
import { resetDb } from './helpers/reset-db';

// supertest's requests to an in-process app are always seen by Express as
// connections from this IPv4-mapped-IPv6 loopback address. `resetDb()` only
// truncates DB tables — it doesn't clear the auth rate limiters' in-memory
// counters, which otherwise persist across every test in this file (a single
// vitest worker) and would eventually 429 unrelated later tests.
const TEST_CLIENT_IP = '::ffff:127.0.0.1';

beforeEach(async () => {
  await resetDb();
  signupRateLimit.resetKey(TEST_CLIENT_IP);
  loginRateLimit.resetKey(TEST_CLIENT_IP);
});

describe('POST /auth/signup', () => {
  it('creates a user and returns a token pair', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('a@example.com');
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.expiresAt).toEqual(expect.any(String));
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'password123' });

    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'anotherpassword' });

    expect(res.status).toBe(409);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('handles concurrent duplicate signups without a 500', async () => {
    const [res1, res2] = await Promise.all([
      request(app).post('/auth/signup').send({ email: 'race@example.com', password: 'password123' }),
      request(app).post('/auth/signup').send({ email: 'race@example.com', password: 'password123' }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'password123' });
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects an incorrect password with a generic error', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('rejects an unknown email with the same generic error', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('takes comparable time for unknown email vs wrong password (timing side-channel check)', async () => {
    const start1 = Date.now();
    await request(app).post('/auth/login').send({ email: 'nobody-timing-test@example.com', password: 'wrongpassword' });
    const unknownEmailMs = Date.now() - start1;

    const start2 = Date.now();
    await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrongpassword' });
    const wrongPasswordMs = Date.now() - start2;

    // Both paths should now pay the bcrypt cost, so the ratio shouldn't be extreme.
    // Generous tolerance to avoid flakiness from normal timing jitter.
    const ratio = Math.max(unknownEmailMs, wrongPasswordMs) / Math.max(1, Math.min(unknownEmailMs, wrongPasswordMs));
    expect(ratio).toBeLessThan(5);
  });
});

describe('POST /auth/refresh', () => {
  it('issues a new token pair and invalidates the old refresh token', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const originalRefreshToken = signupRes.body.refreshToken;

    const refreshRes = await request(app).post('/auth/refresh').send({ refreshToken: originalRefreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.refreshToken).not.toBe(originalRefreshToken);

    const secondRefreshRes = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken });
    expect(secondRefreshRes.status).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('deletes the refresh token, making a later refresh fail', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { refreshToken } = signupRes.body;

    const logoutRes = await request(app).post('/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('is idempotent for an already-invalid token', async () => {
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'never-existed' });
    expect(res.status).toBe(204);
  });
});

describe('auth rate limiting', () => {
  it(
    'rejects the 11th login attempt within the rate-limit window',
    async () => {
      // This describe block doesn't sign up 'a@example.com' first, so every
      // attempt here hits the "unknown email" path. Now that path pays a real
      // bcrypt cost (to close the timing side-channel — see the login tests
      // above), 11 sequential attempts with bcryptjs's pure-JS cost-12 hashing
      // comfortably exceed vitest's default 5s test timeout, hence the bump.
      for (let i = 0; i < 10; i++) {
        await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });
      }
      const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });
      expect(res.status).toBe(429);
    },
    20000,
  );
});
