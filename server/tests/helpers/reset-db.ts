import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "User" RESTART IDENTITY CASCADE',
  );
}
