import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { signupRateLimit } from '../src/routes/auth';
import { resetDb } from './helpers/reset-db';

// supertest's requests to an in-process app are always seen by Express as
// connections from this IPv4-mapped-IPv6 loopback address. `resetDb()` only
// truncates DB tables — it doesn't clear the auth rate limiter's in-memory
// counter, which otherwise persists across every test in this file (a single
// vitest worker) and would eventually 429 the `beforeEach` signup call. See
// the same fix in `auth.test.ts`.
const TEST_CLIENT_IP = '::ffff:127.0.0.1';

let accessToken: string;

beforeEach(async () => {
  await resetDb();
  signupRateLimit.resetKey(TEST_CLIENT_IP);
  const signupRes = await request(app)
    .post('/auth/signup')
    .send({ email: 'a@example.com', password: 'password123' });
  accessToken = signupRes.body.accessToken;
});

describe('GET /saved-fonts', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/saved-fonts');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a fresh account', async () => {
    const res = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.savedFonts).toEqual([]);
  });
});

describe('POST /saved-fonts', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/saved-fonts')
      .send({ fontName: 'Inter', confidence: 92, sources: [] });
    expect(res.status).toBe(401);
  });

  it('saves a font and it appears in the list', async () => {
    const saveRes = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        fontName: 'Inter',
        confidence: 92,
        sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
      });

    expect(saveRes.status).toBe(201);
    expect(saveRes.body.savedFont.fontName).toBe('Inter');

    const listRes = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.savedFonts).toHaveLength(1);
  });

  it('saving the same font name twice updates rather than duplicates', async () => {
    await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 80, sources: [] });
    await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 95, sources: [] });

    const listRes = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.savedFonts).toHaveLength(1);
    expect(listRes.body.savedFonts[0].confidence).toBe(95);
  });

  it('rejects a request missing fontName', async () => {
    const res = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ confidence: 92, sources: [] });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range confidence instead of crashing', async () => {
    const res = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 99999999999999, sources: [] });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /saved-fonts/:id', () => {
  it('requires authentication', async () => {
    const res = await request(app).delete('/saved-fonts/does-not-matter');
    expect(res.status).toBe(401);
  });

  it('removes a saved font', async () => {
    const saveRes = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 92, sources: [] });

    const deleteRes = await request(app)
      .delete(`/saved-fonts/${saveRes.body.savedFont.id}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.savedFonts).toEqual([]);
  });

  it('returns 404 for a saved font belonging to another user', async () => {
    const saveRes = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 92, sources: [] });

    const otherSignup = await request(app)
      .post('/auth/signup')
      .send({ email: 'b@example.com', password: 'password123' });
    const otherToken = otherSignup.body.accessToken;

    const deleteRes = await request(app)
      .delete(`/saved-fonts/${saveRes.body.savedFont.id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(deleteRes.status).toBe(404);
  });

  it('returns exactly one 204 and one 404 when deleting the same font concurrently', async () => {
    // Two `request(app)` calls each spin up their own throwaway listener, and
    // that per-call setup/teardown overhead is enough to serialize the pair
    // before they ever reach the DB — verified empirically: with that
    // pattern this test stayed green even against a deliberately-reverted,
    // genuinely racy findUnique-then-delete handler. Binding one real
    // listener up front and reusing it via a persistent agent removes that
    // artificial serialization.
    //
    // Even then, a single attempt in a fresh process is unreliable: the
    // very first race attempt after a cold start consistently does NOT
    // interleave tightly enough to trigger the bug (verified: 6/6 fresh
    // `tsx` process runs were clean on attempt 1 against the reverted
    // buggy handler), while every subsequent attempt in the same process
    // reliably does (100% across those same 6 runs, 3 follow-up attempts
    // each). Since vitest reruns this file as a fresh process each time,
    // repeating the attempt here is what makes this a reliable regression
    // test instead of a coin flip that happens to pass in CI. The atomic
    // `deleteMany` fix is race-proof regardless of warm-up state (16/16
    // clean across both cold and warm attempts).
    const server = app.listen(0);
    try {
      const agent = request.agent(server);

      for (let i = 0; i < 4; i++) {
        const saveRes = await request(app)
          .post('/saved-fonts')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ fontName: `Concurrent${i}`, confidence: 92, sources: [] });

        const [first, second] = await Promise.all([
          agent.delete(`/saved-fonts/${saveRes.body.savedFont.id}`).set('Authorization', `Bearer ${accessToken}`),
          agent.delete(`/saved-fonts/${saveRes.body.savedFont.id}`).set('Authorization', `Bearer ${accessToken}`),
        ]);

        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([204, 404]);
      }
    } finally {
      server.close();
    }
  });
});
