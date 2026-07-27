import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/require-auth';
import { ApiError } from '../middleware/error-handler';

export const fontSubmissionsRouter = Router();

fontSubmissionsRouter.use(requireAuth);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// The submitter's own belief counts as the first supporter; this many
// independent people (submitter + confirmers) agreeing is enough to
// auto-promote. An empirically-unvalidated starting point — there's no
// existing crowdsourced-agreement data to calibrate against yet, same
// treatment as this project's other tunable thresholds (e.g.
// MARGIN_THRESHOLD in font-matches.ts).
const CONFIRMATION_THRESHOLD = 3;

function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

async function checkAndPromote(submissionId: string): Promise<void> {
  const submission = await prisma.fontSubmission.findUnique({
    where: { id: submissionId },
    include: { confirmations: true },
  });
  if (!submission || submission.status !== 'pending') return;
  const supporterCount = 1 + submission.confirmations.length;
  if (supporterCount < CONFIRMATION_THRESHOLD) return;

  // Each distinct proposed URL becomes its own ranked source, with votes equal
  // to how many distinct people proposed exactly that URL — the submission's
  // own sourceUrl (attributed to the original submitter) and each
  // confirmation's sourceUrl (attributed to that confirmer) are tracked
  // independently and never merged onto each other's row, so a URL can never
  // be double-counted as coming from two people when only one actually
  // proposed it.
  const proposals = new Map<string, Set<string>>();
  function addProposal(url: string | null, proposerId: string): void {
    if (!url) return;
    const proposers = proposals.get(url) ?? new Set<string>();
    proposers.add(proposerId);
    proposals.set(url, proposers);
  }
  addProposal(submission.sourceUrl, submission.submittedBy);
  for (const confirmation of submission.confirmations) {
    addProposal(confirmation.sourceUrl, confirmation.confirmedBy);
  }

  await prisma.$transaction(async (tx) => {
    const normalizedName = submission.fontName.toLowerCase();
    let font = await tx.font.findFirst({
      where: { name: { equals: submission.fontName, mode: 'insensitive' } },
    });
    if (!font) {
      font = await tx.font.create({
        data: { name: submission.fontName, matchKeys: [normalizedName] },
      });
    } else if (!font.matchKeys.includes(normalizedName)) {
      // Reusing a pre-existing Font row (e.g. one seeded by the AI-catalog build
      // script, which never populates matchKeys) must not leave it permanently
      // unresolvable via GET /fonts/resolve, which matches only on matchKeys.
      font = await tx.font.update({
        where: { id: font.id },
        data: { matchKeys: { push: normalizedName } },
      });
    }

    const existingSources = await tx.fontSource.findMany({ where: { fontId: font.id } });
    const existingUrls = new Set(existingSources.map((s) => s.url));

    for (const [url, proposers] of proposals) {
      if (existingUrls.has(url)) continue;
      await tx.fontSource.create({
        data: { fontId: font.id, url, label: hostnameOf(url), votes: proposers.size },
      });
    }

    await tx.fontSubmission.update({ where: { id: submissionId }, data: { status: 'promoted' } });
  });
}

fontSubmissionsRouter.get('/pending', async (_req, res, next) => {
  try {
    const submissions = await prisma.fontSubmission.findMany({
      where: { status: 'pending' },
      include: { _count: { select: { confirmations: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({
      submissions: submissions.map((s) => ({
        id: s.id,
        fontName: s.fontName,
        confirmationCount: 1 + s._count.confirmations,
      })),
    });
  } catch (error) {
    next(error);
  }
});

fontSubmissionsRouter.post('/', upload.single('image'), async (req, res, next) => {
  try {
    const { fontName, sourceUrl } = req.body as { fontName?: unknown; sourceUrl?: unknown };

    if (typeof fontName !== 'string' || fontName.trim().length === 0) {
      throw new ApiError(400, 'fontName is required');
    }
    if (sourceUrl !== undefined && sourceUrl !== '') {
      if (typeof sourceUrl !== 'string') {
        throw new ApiError(400, 'sourceUrl must be a string');
      }
      try {
        new URL(sourceUrl);
      } catch {
        throw new ApiError(400, 'sourceUrl must be a valid URL');
      }
    }
    if (!req.file) {
      throw new ApiError(400, 'image is required');
    }

    const userId = req.userId as string;
    const trimmedName = fontName.trim();
    const validSourceUrl = typeof sourceUrl === 'string' && sourceUrl !== '' ? sourceUrl : null;

    const existing = await prisma.fontSubmission.findFirst({
      where: { status: 'pending', fontName: { equals: trimmedName, mode: 'insensitive' } },
    });

    if (existing) {
      if (existing.submittedBy === userId) {
        res.status(200).json({ submissionId: existing.id, status: existing.status });
        return;
      }

      await prisma.fontSubmissionConfirmation.upsert({
        where: { submissionId_confirmedBy: { submissionId: existing.id, confirmedBy: userId } },
        create: { submissionId: existing.id, confirmedBy: userId, sourceUrl: validSourceUrl },
        update: validSourceUrl !== null ? { sourceUrl: validSourceUrl } : {},
      });

      await checkAndPromote(existing.id);

      const updated = await prisma.fontSubmission.findUnique({ where: { id: existing.id } });
      res.status(200).json({ submissionId: existing.id, status: updated!.status });
      return;
    }

    const created = await prisma.fontSubmission.create({
      data: {
        fontName: trimmedName,
        sourceUrl: validSourceUrl,
        sampleImage: new Uint8Array(req.file.buffer),
        submittedBy: userId,
        status: 'pending',
      },
    });

    res.status(201).json({ submissionId: created.id, status: 'pending' });
  } catch (error) {
    next(error);
  }
});

fontSubmissionsRouter.post('/:id/confirm', async (req, res, next) => {
  try {
    const submission = await prisma.fontSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission || submission.status !== 'pending') {
      throw new ApiError(404, 'Pending submission not found');
    }

    const userId = req.userId as string;
    if (submission.submittedBy === userId) {
      throw new ApiError(400, 'You cannot confirm your own submission');
    }

    const { sourceUrl } = req.body as { sourceUrl?: unknown };
    if (sourceUrl !== undefined && sourceUrl !== null && sourceUrl !== '') {
      if (typeof sourceUrl !== 'string') {
        throw new ApiError(400, 'sourceUrl must be a string');
      }
      try {
        new URL(sourceUrl);
      } catch {
        throw new ApiError(400, 'sourceUrl must be a valid URL');
      }
    }
    const validSourceUrl = typeof sourceUrl === 'string' && sourceUrl !== '' ? sourceUrl : null;

    await prisma.fontSubmissionConfirmation.upsert({
      where: { submissionId_confirmedBy: { submissionId: submission.id, confirmedBy: userId } },
      create: { submissionId: submission.id, confirmedBy: userId, sourceUrl: validSourceUrl },
      update: validSourceUrl !== null ? { sourceUrl: validSourceUrl } : {},
    });

    await checkAndPromote(submission.id);

    const updated = await prisma.fontSubmission.findUnique({
      where: { id: submission.id },
      include: { _count: { select: { confirmations: true } } },
    });

    res.status(200).json({
      status: updated!.status,
      confirmationCount: 1 + updated!._count.confirmations,
    });
  } catch (error) {
    next(error);
  }
});
