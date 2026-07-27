import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';

export const fontsRouter = Router();

// Mirrors findKnownFont's client-side candidate extraction (comma-split, trim,
// strip surrounding quotes, lowercase) so the server fallback behaves
// identically to the local tier it's backing up, regardless of which one
// actually resolves a given font-family stack. Deliberate deviation: this
// also drops empty candidates (e.g. from a trailing comma), which
// findKnownFont doesn't bother with client-side — harmless there since an
// empty string never matches a matchKey, but here it also skips a wasted
// findFirst query.
function extractCandidates(fontFamilyStack: string): string[] {
  return fontFamilyStack
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter((entry) => entry.length > 0);
}

fontsRouter.get('/resolve', optionalAuth, async (req, res, next) => {
  try {
    const { name } = req.query;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ApiError(400, 'name is required');
    }

    const candidates = extractCandidates(name);

    for (const candidate of candidates) {
      const font = await prisma.font.findFirst({
        where: { matchKeys: { has: candidate } },
        include: { sources: { orderBy: { votes: 'desc' } } },
      });
      if (font) {
        res.status(200).json({
          fontName: font.name,
          sources: font.sources.map((s) => ({ url: s.url, label: s.label, votes: s.votes })),
        });
        return;
      }
    }

    throw new ApiError(404, 'Font not found');
  } catch (error) {
    next(error);
  }
});
