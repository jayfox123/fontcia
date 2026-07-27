import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "FontSubmissionConfirmation", "FontSubmission", "User", "FontEmbedding", "Font" RESTART IDENTITY CASCADE',
  );
}
