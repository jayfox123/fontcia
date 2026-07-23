import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/require-auth';
import { ApiError } from '../middleware/error-handler';

export const savedFontsRouter = Router();

savedFontsRouter.use(requireAuth);

savedFontsRouter.get('/', async (req, res, next) => {
  try {
    const savedFonts = await prisma.savedFont.findMany({
      where: { userId: req.userId },
      orderBy: { savedAt: 'desc' },
    });
    res.status(200).json({ savedFonts });
  } catch (error) {
    next(error);
  }
});

savedFontsRouter.post('/', async (req, res, next) => {
  try {
    const { fontName, confidence, sources } = req.body as {
      fontName?: unknown;
      confidence?: unknown;
      sources?: unknown;
    };

    if (typeof fontName !== 'string' || fontName.length === 0) {
      throw new ApiError(400, 'fontName is required');
    }
    if (typeof confidence !== 'number' || !Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
      throw new ApiError(400, 'confidence must be an integer between 0 and 100');
    }
    if (!Array.isArray(sources)) {
      throw new ApiError(400, 'sources must be an array');
    }

    const userId = req.userId as string;
    const savedFont = await prisma.savedFont.upsert({
      where: { userId_fontName: { userId, fontName } },
      create: { userId, fontName, confidence, sources },
      update: { confidence, sources },
    });

    res.status(201).json({ savedFont });
  } catch (error) {
    next(error);
  }
});

savedFontsRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await prisma.savedFont.deleteMany({
      where: { id: req.params.id, userId: req.userId },
    });

    if (result.count === 0) {
      throw new ApiError(404, 'Saved font not found');
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
