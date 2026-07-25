import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';
import { getEmbedding } from '../lib/embedding-client';
import { toVectorLiteral } from '../lib/vector-format';

export const fontMatchesRouter = Router();

const upload = multer({ storage: multer.memoryStorage() });

const TOP_K = 5;

interface MatchRow {
  fontName: string;
  googleSlug: string;
  distance: number;
}

fontMatchesRouter.post('/', optionalAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, 'image is required');
    }

    const embedding = await getEmbedding(req.file.buffer);
    const vectorLiteral = toVectorLiteral(embedding);

    const rows = await prisma.$queryRaw<MatchRow[]>`
      SELECT "Font".name AS "fontName", "Font"."googleSlug" AS "googleSlug",
             "FontEmbedding".embedding <=> ${vectorLiteral}::vector AS distance
      FROM "FontEmbedding"
      JOIN "Font" ON "Font".id = "FontEmbedding"."fontId"
      ORDER BY distance ASC
      LIMIT ${TOP_K}
    `;

    const matches = rows.map((row) => ({
      fontName: row.fontName,
      confidence: Math.round((1 - row.distance / 2) * 100),
      sources: [
        {
          url: `https://fonts.google.com/specimen/${row.googleSlug.replace(/ /g, '+')}`,
          label: 'Google Fonts',
          votes: 1,
        },
      ],
    }));

    res.status(201).json({ matches });
  } catch (error) {
    next(error);
  }
});
