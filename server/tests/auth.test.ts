import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
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
  it('rejects the 11th login attempt within the rate-limit window', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });
    }
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });
    expect(res.status).toBe(429);
  });
});
