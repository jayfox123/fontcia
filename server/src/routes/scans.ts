import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { requireAuth } from '../middleware/require-auth';
import { ApiError } from '../middleware/error-handler';

export const scansRouter = Router();

// v1 cap, not true pagination — same treatment as this project's other
// list-endpoint size limits (e.g. TOP_K in font-matches.ts).
const SCAN_HISTORY_LIMIT = 50;

scansRouter.post('/', optionalAuth, async (req, res, next) => {
  try {
    const { status, fontName, confidence } = req.body as {
      status?: unknown;
      fontName?: unknown;
      confidence?: unknown;
    };

    if (status !== 'match' && status !== 'no-match') {
      throw new ApiError(400, "status must be 'match' or 'no-match'");
    }

    const validConfidence =
      typeof confidence === 'number' && Number.isInteger(confidence) && confidence >= 0 && confidence <= 100
        ? confidence
        : null;

    const scan = await prisma.scan.create({
      data: {
        userId: req.userId ?? null,
        status,
        fontName: typeof fontName === 'string' ? fontName : null,
        confidence: validConfidence,
      },
    });

    res.status(201).json({ id: scan.id, createdAt: scan.createdAt });
  } catch (error) {
    next(error);
  }
});

scansRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const scans = await prisma.scan.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: SCAN_HISTORY_LIMIT,
    });
    res.status(200).json({ scans });
  } catch (error) {
    next(error);
  }
});
