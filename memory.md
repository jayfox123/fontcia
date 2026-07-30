# fontCIA — Memory

Permanent facts and decisions only. If it's a task to do, it goes in handoff.md or backlog.md, not here.

## Durable decisions

- DOM-only first for the MVP scan path — v1 reads exact CSS (`font-family`/`font-weight`/`font-style`) instead of building AI/embeddings/vector search up front. This is the project's founding "simplest viable slice, defer the next layer" pattern, reused later for capture-only-before-matching.
- Chrome-only for launch. Manifest V3. Firefox/Edge/Safari are explicitly deferred, not ruled out forever.
- Two tiers: Free ($0/month, 20 scans/month) and Pro ($6/month, unlimited scans). Scan-count tracking and gating plumbing should exist from day one even before Step 8 enforces it, so it isn't retrofitted later.
- Subagent-driven development is the default execution approach for every sub-project — each sub-project's plan requires `superpowers:subagent-driven-development` (or `executing-plans` as fallback) to implement it task-by-task.
- Branch-per-sub-project, merged locally to `master`, no pull-request workflow. Solo project, so a branch per sub-project (`extension-shell`, `dom-font-resolution`, `font-matching-backend`, etc.) gets checked out, built, and merged straight back to `master` — no remote branches, no PRs.
- Never scrape competitor font-matching databases (WhatFontIs, WhatTheFont, or similar) — real legal/ToS risk was evaluated and rejected. Google Fonts' public API is the only legitimate automated catalog-expansion path.
- Local-first, server-fallback for font resolution: DOM lookup must stay fast and client-side; a server call only happens when local lookup fails, never on the common path. This has already been explicitly protected twice — once in Step 4 (backend API is a fallback, not a requirement for a basic scan) and again in Step 6 (`GET /fonts/resolve` is a fallback lookup, not a replacement for the bundled known-fonts table).
- Pretrained embedding model used as a fixed feature extractor (DINOv2, `facebook/dinov2-small`), never custom-trained or fine-tuned — no training pipeline exists in this project by design.
- `bcryptjs` over native `bcrypt`, and Puppeteer/headless-browser rendering over a native font-rasterization library — both chosen specifically to avoid native-binding build friction, a precedent set in sub-project 4a and reused in the font-matching backend.

## Terms and names used in this project

- **DOM path** — the original scan path: real webpage text, resolved via computed CSS styles against the bundled `known-fonts` table (client-side) or `GET /fonts/resolve` (server fallback). Produces one confident, exact result.
- **AI path / AI image-matching path** — the phase-2 scan path for text baked into images or video: a cropped screenshot sent to `POST /font-matches`, matched via DINOv2 embeddings and pgvector cosine similarity against the curated font catalog. Produces 0-5 ranked, uncertain candidates, never a single "confident" answer.
- **Promoted** — the terminal status of a `FontSubmission` once it reaches `CONFIRMATION_THRESHOLD` (3: the original submitter plus 2 independent confirmers). Promotion makes the submission durably `'promoted'` and, since Step 6, makes it findable via the DOM path's server fallback — it never makes a font embeddable or matchable via the AI path.
- **Confirmation** — a lightweight `FontSubmissionConfirmation` join row (who + when) added when a different logged-in user affirms someone else's pending submission. Idempotent (a second click from the same confirmer doesn't error) and self-confirmation is blocked so a submitter can't reach the threshold alone.
- **`matchKeys`** — a normalized-name array on `Font`, the field the DOM path's `GET /fonts/resolve` actually matches against. Must be backfilled any time a submission's promotion reuses an existing `Font` row instead of creating one.
- **`FontEmbedding`** — a table joining `Font` to a DINOv2 vector. Only ever populated by `scripts/build-reference-set.ts` for the curated AI catalog; never populated for a promoted/enrolled font, since there's no real font file to embed.
- **`DISTANCE_CEILING` / `MARGIN_THRESHOLD`** — the two empirically-derived constants that turn a raw pgvector cosine distance into a confidence percentage and decide when to reject a match as too ambiguous to show. Explicitly flagged as unvalidated against genuinely out-of-catalog fonts.

## Things that must always stay true

- Never store or redistribute actual font files — only names, small sample crops, and source links.
- Promoted community-enrolled fonts can never enter the AI image-matching catalog, since there's no real font file to generate an embedding from. Enforced structurally through the `FontEmbedding` join, not a flag that could be forgotten.
- DOM font resolution must never regress to requiring a network call on the common path — server calls are fallback-only.
- Anonymous scanning must keep working — login is required for saving, history, and enrollment, never for a basic scan.
- No em dashes anywhere in project output.

## Lessons learned (things that broke before, don't repeat)

- The selection surface's cursor was set once at creation and never reset, so the crosshair kept showing over the page after a selection locked even though dragging was correctly inert (`22a001b`).
- The locked overlay kept swallowing clicks outside the box/panel. First fix set `pointer-events: none` on the shadow surface (`2bff259`) — insufficient in a real browser. The actual fix had to target `hostEl`, the light-DOM element covering the viewport, not the shadow-root surface (`86d7b12`). Two fixes, wrong layer first.
- `handleIconClick` called `chrome.scripting.executeScript` unconditionally, which throws on `chrome://`, `chrome-extension://`, and Web Store pages, surfacing as a silent "crosshair no-show" (most likely a session-restored `chrome://extensions` tab). Fixed with an `isInjectableUrl()` allow-list rather than enumerating every restricted scheme (`09d1e8d`).
- The AI match confidence formula assumed cosine distances span meaningfully across `[0, 2]`; measured against real fonts they cluster in ~0.004-0.04, so the naive formula saturated almost everything to 95-100% — wrong top-1 guesses scored a *higher* mean confidence (99.7) than correct ones (99.3). Fixed by rescaling against the observed range and rejecting matches where the top-two margin is too small to call (`46b928e`).
- `checkAndPromote` only set `matchKeys` on the branch that created a new `Font` row; when promotion reused an existing row (case-insensitive name match, including the 100 seeded AI-catalog rows), `matchKeys` was left untouched, leaving the submission permanently unresolvable via `GET /fonts/resolve` despite showing as `'promoted'` (`f5e8d74`).

---
Keep this file short. If it gets long and cluttered, that's a sign to move old stuff into an archive note instead of deleting it, and keep only what's still true.
