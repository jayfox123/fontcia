import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('POST /scans', () => {
  it('logs an anonymous scan with no Authorization header', async () => {
    const res = await request(app).post('/scans').send({ status: 'match', fontName: 'Inter', confidence: 92 });
    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));

    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.userId).toBeNull();
  });

  it('associates the scan with the authenticated user when a valid token is present', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken, user } = signupRes.body;

    const res = await request(app)
      .post('/scans')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'no-match' });

    expect(res.status).toBe(201);
    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.userId).toBe(user.id);
  });

  it('rejects a missing/invalid status', async () => {
    const res = await request(app).post('/scans').send({ status: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('still logs anonymously when given an invalid token', async () => {
    const res = await request(app)
      .post('/scans')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ status: 'match', fontName: 'Inter', confidence: 92 });

    expect(res.status).toBe(201);
    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.userId).toBeNull();
  });

  it('stores null confidence instead of crashing on an out-of-range value', async () => {
    const res = await request(app).post('/scans').send({ status: 'match', confidence: 99999999999999 });
    expect(res.status).toBe(201);

    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.confidence).toBeNull();
  });

  it('stores null confidence instead of silently truncating a non-integer value', async () => {
    const res = await request(app).post('/scans').send({ status: 'match', confidence: 92.7 });
    expect(res.status).toBe(201);

    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.confidence).toBeNull();
  });
});
