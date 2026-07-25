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

    // Note: the distance computation is wrapped in a MATERIALIZED CTE so Postgres
    // computes it via a plain sequential scan rather than pushing the ORDER BY/LIMIT
    // down into the FontEmbedding_embedding_idx ivfflat index. That index is only as
    // good as the training data present when it was built/last reindexed; on a small
    // or freshly-loaded font catalog its approximate search can silently under-recall
    // (miss true nearest neighbors, including exact matches). An exact scan is cheap
    // at this table's scale and guarantees correct, deterministic ranking.
    const rows = await prisma.$queryRaw<MatchRow[]>`
      WITH candidates AS MATERIALIZED (
        SELECT "Font".name AS "fontName", "Font"."googleSlug" AS "googleSlug",
               "FontEmbedding".embedding <=> ${vectorLiteral}::vector AS distance
        FROM "FontEmbedding"
        JOIN "Font" ON "Font".id = "FontEmbedding"."fontId"
      )
      SELECT "fontName", "googleSlug", distance
      FROM candidates
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
