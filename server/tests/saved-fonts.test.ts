import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { resetDb } from './helpers/reset-db';

let accessToken: string;

beforeEach(async () => {
  await resetDb();
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
});
