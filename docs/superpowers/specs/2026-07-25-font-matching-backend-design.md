# fontCIA — Font Matching Backend Design (Sub-project 2 of AI Image Matching phase)

**Status:** Approved
**Scope:** Given a cropped image (the `Blob` the image-capture pipeline already produces, merged in the prior sub-project), identify which font it most likely shows by comparing it against a reference set built from a curated subset of Google Fonts, and return ranked matches with confidence. **Backend only** — no client wiring in this sub-project (mirroring the 4a/4b split), no custom-trained model, no full ~1,500-font catalog.

## Context

The just-merged image-capture pipeline captures and crops a screenshot when DOM font-resolution finds no text, holding the resulting `Blob` in memory behind an "Analyzing image…" placeholder with no real matcher to hand it to. This sub-project builds that matcher's backend. It also pays down a piece of debt sub-project 4a's spec explicitly flagged and deferred: `SavedFont.sources` was designed as "a denormalized JSON snapshot... not a foreign key into a `Font`/`Source` table — those don't exist until Step 5/6." Those tables get built here.

## Confirmed decisions

- **Approach: a pretrained vision embedding model used as a fixed feature extractor, not a custom-trained model, not classical CV/perceptual hashing.** No training pipeline exists in this project, and building one would be the expensive-first-version mistake this project has consistently avoided (DOM-only before AI, mock-scan before real resolution, capture-only before matching). Classical hashing/handcrafted-feature approaches were considered and rejected — they're fragile against the mixed backgrounds and varied rendering conditions of real captured web content, and would likely underperform a modern pretrained embedding model despite looking "simpler."
- **Model: DINOv2** (`facebook/dinov2-small`, 384-dimensional output), not CLIP — DINOv2's self-supervised training targets fine-grained visual/shape/texture similarity, which is closer to what separating typefaces needs, versus CLIP's image↔caption semantic alignment. **Explicitly flagged as unvalidated**: neither model was trained with fonts in mind, and how well it discriminates closely related typefaces is a genuinely open question this sub-project's evaluation step (below) exists to answer.
- **Embedding inference runs in a separate Python microservice**, not in the Node backend via ONNX. Python's ML tooling for this exact task is mature and low-effort; fighting ONNX export/compatibility edge cases in Node was judged a bigger risk for a first pass than the operational cost of a second runtime.
- **Reference renders are generated via headless-browser screenshot (Puppeteer)**, not a native font-rasterization library — reusing the same "load a font via CSS, render it" approach already central to this whole project, and avoiding the native-binding build friction this project has explicitly avoided before (the bcryptjs-over-bcrypt precedent from 4a).
- **Storage: pgvector on the existing Postgres** (the same instance from 4a), with a new `Font`/`FontEmbedding` schema and an ANN index for fast similarity search.
- **v1 catalog: a curated 100-font subset**, not the full Google Fonts catalog — enough to be a meaningful test of retrieval accuracy, small enough to build and iterate on quickly. The pipeline itself is generic over any font list, so expanding later is a data change, not a rebuild.
- **Crop preprocessing is minimal**: resize/pad to the model's input size only. These crops come from rendered web content, not photographs, so the usual "in the wild" font-ID headaches (perspective skew, physical lighting, camera noise) mostly don't apply.
- **API**: a new `POST /font-matches` endpoint, multipart image upload, **optional auth** (matching `/scans`' pattern — anonymous scanning must keep working), response reusing the existing `ScanSource`/confidence shape so it can plug into the current scan-dialogue `MatchResult` UI with no new UI work once client wiring happens.
- **An empirical evaluation deliverable is mandatory for this sub-project**, not an afterthought: a held-out test set and a script reporting real top-1/top-3/top-5 retrieval accuracy against the curated catalog. No numeric accuracy bar is pre-committed in this spec — that would be false precision given the honestly-flagged uncertainty above. The evaluation script's actual output is a required artifact of this sub-project's completion, and "is this good enough to build client wiring on top of" is a decision made after seeing real numbers, not before.

## Architecture

### New components

```
embedding-service/              — new, sibling to server/, a small Python microservice
  main.py                       — FastAPI app, loads DINOv2 once at startup
  requirements.txt              — fastapi, uvicorn, transformers, torch, pillow
  Dockerfile

server/                         — existing 4a/4b backend, gains:
  prisma/schema.prisma           — new Font, FontEmbedding models
  src/routes/font-matches.ts     — POST /font-matches
  src/lib/embedding-client.ts    — calls embedding-service's /embed
  scripts/
    build-reference-set.ts       — offline: render + embed + store the curated catalog
    evaluate-matching.ts         — offline: measure retrieval accuracy against a held-out set
    fonts.json                   — the curated 100-font list (name + Google Fonts slug)
  docker-compose.yml             — postgres image swapped for a pgvector-enabled one
```

`embedding-service` is internal-only — reachable from `server/` over the Docker network, never exposed to the browser extension directly. It has no database access and no auth of its own; it's a pure inference wrapper.

### Embedding service contract

```
POST /embed
Content-Type: multipart/form-data (field: image)

200 { embedding: number[] }   — length 384, one call = one image
4xx/5xx { error: string }
```

Multipart, not base64/JSON, for consistency with how `/font-matches` itself receives images — no unnecessary encoding round-trip.

### Database schema

```prisma
model Font {
  id         String          @id @default(uuid())
  name       String          @unique
  googleSlug String
  category   String?         // e.g. "serif" | "sans-serif" | "display" | "monospace"
  embeddings FontEmbedding[]
}

model FontEmbedding {
  id           String                   @id @default(uuid())
  fontId       String
  font         Font                     @relation(fields: [fontId], references: [id])
  renderVariant String                  // e.g. "regular-pangram" — which sample this embedding came from
  embedding    Unsupported("vector(384)")
  createdAt    DateTime                 @default(now())

  @@index([fontId])
}
```

Prisma doesn't natively model pgvector's `vector` type, so `Unsupported("vector(384)")` is used for the column, and similarity queries go through `prisma.$queryRaw` rather than Prisma's normal query builder (which has no concept of vector distance operators). `server/docker-compose.yml`'s Postgres image changes from `postgres:16` to `pgvector/pgvector:pg16` (a real, existing image bundling Postgres 16 with the pgvector extension pre-installed), and the migration adds `CREATE EXTENSION IF NOT EXISTS vector;` before creating `FontEmbedding`, plus an `ivfflat` ANN index on the `embedding` column for fast approximate nearest-neighbor search.

v1 renders exactly one variant per font (`regular-pangram`) — no bold/italic/multi-weight embeddings yet. Simpler for a first pass; the schema already supports multiple `FontEmbedding` rows per `Font` for when that's added later.

### Reference-set build (`server/scripts/build-reference-set.ts`, offline/on-demand)

1. Read `server/scripts/fonts.json` — a hand-curated list of 100 font family names + their Google Fonts slugs (seeded from the existing 10-entry `known-fonts.ts` table plus 90 more popular families).
2. For each font: fetch the font file from the Google Fonts CDN by family name (not vendored into the repo — matches how `known-fonts.ts`'s `googleFontsSource()` already links to Google Fonts URLs without bundling font files, and keeps the repo free of large binary diffs).
3. Launch Puppeteer, load a minimal HTML page with an `@font-face` rule pointing at the fetched font file, render a fixed pangram ("The quick brown fox jumps over the lazy dog") at a fixed size (32px) as black text on a white background, in a fixed 400×120 viewport, and screenshot the render.
4. POST the screenshot to `embedding-service`'s `/embed`, get back the 384-dim vector.
5. Upsert the `Font` row, insert a `FontEmbedding` row with `renderVariant: 'regular-pangram'`.

### Live matching request (`POST /font-matches`)

1. Accept a multipart image upload (`optionalAuth`, matching `/scans`).
2. Resize/pad the image to DINOv2's expected input size.
3. Call `embedding-service`'s `/embed` to get the query's 384-dim vector.
4. Run a pgvector cosine-distance nearest-neighbor query (`<=>` operator) against `FontEmbedding`, ordered by distance ascending, `LIMIT 5`.
5. Map each result's cosine distance (range `[0, 2]`, 0 = identical) to a confidence percentage: `confidence = round((1 - distance / 2) * 100)`. This formula is a starting point, not empirically tuned — same treatment the image-capture pipeline's `BLACKNESS_THRESHOLD` got, adjustable once the evaluation script (below) produces real numbers.
6. Map each matched `Font` to the existing `ScanSource` response shape, reusing/adapting `known-fonts.ts`'s Google-Fonts-URL construction logic.
7. Respond `201 { matches: [{ fontName, confidence, sources }] }`.

### Evaluation (`server/scripts/evaluate-matching.ts`, offline/on-demand)

For each font in the curated catalog, render a second, different sample (a different pangram/phrase, so it's not testing the pipeline against the exact image it was indexed from) through the same Puppeteer pipeline, run it through the full live-matching flow (steps 2-6 above), and record whether the correct font appears in the top-1/top-3/top-5 results. Report aggregate accuracy at each of those thresholds. This script's output is a required deliverable of this sub-project — the real numbers it produces are what determine whether this approach is good enough to build client wiring on, not an assumption made in this spec.

## Testing

- **Non-ML backend code** (route validation, request/response shaping, the pgvector query itself): real Postgres with pgvector, Vitest + supertest, exactly matching 4a's established testing philosophy. The similarity-search logic is tested by inserting synthetic embeddings directly into the test DB — no need to call the real embedding service in these tests.
- **`embedding-service`** (Python): a minimal smoke test confirming `/embed` returns a 384-length vector for a sample image — not asserting specific embedding values, which would be brittle and meaningless. This is the Python-side equivalent of the "real APIs, smoke-verified rather than exhaustively unit-tested" treatment already given to `captureAndCropSelection` and `readFontAtPoint` elsewhere in this project.
- **`build-reference-set.ts`/`evaluate-matching.ts`**: manual/on-demand tools, not part of the automated test suite — their outputs (a populated reference DB, an accuracy report) are the real verification artifacts for this sub-project.

## Out of scope for this spec

Client-side wiring (a follow-up sub-project — the capture pipeline's "Analyzing image…" placeholder is untouched here). The full ~1,500-font Google Fonts catalog. A custom-trained embedding model. Bold/italic/multi-weight reference renders. Production deployment/hosting of `embedding-service` (this sub-project covers local dev via Docker Compose, matching 4a's precedent of deferring production deployment). Any UI/UX changes beyond the API response shape.
