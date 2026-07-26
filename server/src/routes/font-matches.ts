import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';
import { getEmbedding } from '../lib/embedding-client';
import { toVectorLiteral } from '../lib/vector-format';

export const fontMatchesRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

const TOP_K = 5;

// DINOv2 cosine distances between these font renderings all cluster in a
// tiny sliver of the theoretical [0, 2] range (empirically ~0.004-0.04),
// dominated by the shared "text on white background" composition rather
// than font identity. A fixed (1 - distance/2) formula saturates almost
// every candidate to 95-100%, regardless of match quality — measured
// against 100 real matches, WRONG top-1 guesses scored a HIGHER mean
// confidence (99.7) than CORRECT ones (99.3). DISTANCE_CEILING rescales
// against the actual observed range instead, so the number means
// something; it's an empirically-derived starting point, not validated
// against out-of-catalog data, same treatment as this project's other
// tunable heuristics (e.g. the capture pipeline's BLACKNESS_THRESHOLD).
const DISTANCE_CEILING = 0.05;

// Absolute distance doesn't separate correct from wrong guesses (CORRECT
// median distance was actually *higher* than WRONG's in the same
// measurement), but the GAP between the top-1 and top-2 candidates does:
// CORRECT top-1s had a median margin of 0.0035, WRONG top-1s only 0.0006 —
// a clear winner tends to stand out from the runner-up; an uncertain guess
// doesn't. Below this threshold, nothing is returned rather than a
// confident-looking wrong guess. Empirically derived from the same 100-font
// closed-set measurement above — a reasonable starting point for "is this
// font in our catalog at all", not a validated one (no genuinely
// out-of-catalog fonts were available to test against).
const MARGIN_THRESHOLD = 0.001;

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

    const hasNoClearWinner = rows.length >= 2 && rows[1].distance - rows[0].distance < MARGIN_THRESHOLD;

    const matches = hasNoClearWinner
      ? []
      : rows.map((row) => ({
          fontName: row.fontName,
          confidence: Math.round(Math.max(0, 1 - row.distance / DISTANCE_CEILING) * 100),
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
