import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';

export const scansRouter = Router();

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
