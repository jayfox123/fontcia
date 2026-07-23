import { describe, it, expect } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

describe('database connection', () => {
  it('connects to the test database and can reset it', async () => {
    await resetDb();
    const userCount = await prisma.user.count();
    expect(userCount).toBe(0);
  });
});
