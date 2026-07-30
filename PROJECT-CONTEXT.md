# fontCIA — Project Context

## What is fontCIA?

A Chrome browser extension that lets users draw a selection box over any text on screen, in a webpage, an image, or a video frame, and identifies the font, giving a link to where it can be obtained. If it can't recognize a font, users can submit its name so the community-driven database grows over time.

## Who uses it?

Designers, video editors, marketers, and content creators who spot a font they like and want to identify and reuse it. Secondary: students and hobbyists building mood boards, developers matching brand typography.

## Main features (what it should do when 100% done)

- Grid/box selection over any on-page area
- DOM-based font detection (exact CSS read for real webpage text, no AI needed, near-instant)
- AI-based image matching (for text baked into images/video, using a DINOv2 embedding model against a Google Fonts-based reference catalog)
- Scan result with font name, confidence, and source link(s)
- No-match to enrollment flow (name it, peer-confirmation-based promotion to the live database)
- Multi-source results (one font, many community-found links, ranked by votes)
- Accounts (email/password plus JWT), saved/starred font library, scan history
- Working dark/light theme toggle
- Free (20 scans/month) and Pro ($6/month unlimited) tiers

## What's already built (as of today)

**Step 1 — Extension shell:** icon click, crosshair cursor, shadow-DOM selection overlay, drag-to-lock selection box.

**Step 2 — Scan dialogue UI:** ready/loading/result/no-match states, both themes, originally wired to a mocked response.

**Step 3 — DOM font resolution:** reads computed `font-family`/`font-weight`/`font-style` from the selected node(s) and matches against a bundled known-fonts table (seeded with 10 Google Fonts).

**Sub-project 4a — Backend API:** auth, known-fonts lookup, scan logging, saved-fonts endpoints, rate limiting on `/auth/signup` and `/auth/login`.

**Sub-project 4b — Client/backend wiring:** API client with 401-refresh-and-retry, chrome.storage.local-backed auth, Save/Unsave and scan logging wired to the backend, login prompt when logged out.

**AI Image Matching phase (inserted as a detour ahead of the original roadmap order, between 4b and Step 5):**
- Image capture pipeline: capture-and-crop of a selection when DOM resolution finds no text, DPR-aware crop math, blackness detection
- Font-matching backend: `embedding-service` Python microservice loading DINOv2 (`facebook/dinov2-small`) as a fixed feature extractor, Puppeteer-based reference-set build pipeline, pgvector cosine-similarity search over a curated 100-font catalog, `POST /font-matches`, retrieval-accuracy evaluation script
- Image-match client wiring: captured image `Blob` wired to `/font-matches`, ranked-matches / no-confident-match / match-error UI states, confidence rescaled and ambiguous matches rejected based on real measured distance distributions

**Step 5 — Enrollment flow:** "Name it" wired end-to-end, `FontSubmission`/`FontSubmissionConfirmation` schema, submission requires multiple independent confirmations before promotion (no moderator role exists or is needed for this).

**Step 6 — Multi-source results:** unified `Font`/`FontSource` model, promoted enrollment submissions become findable via the DOM path, `GET /fonts/resolve` server-side fallback, one matched font can show multiple ranked sources with real vote counts.

**Step 7 — Account dashboard:** login/signup view, saved-fonts view, scan-history view, settings view with a working theme toggle, tab orchestration with stale-render guards. Password change and account deletion were explicitly scoped out. Manifest and build now point at this dashboard; the old standalone login page was removed.

## What's NOT built yet

- Step 8: usage/tier gating (Free vs Pro scan limits not yet enforced)
- Google Fonts catalog expansion (still a small seeded set, not the full ~1,500 discussed)
- Manual Chrome test passes that were deliberately skipped: sub-project 4b (client/backend wiring) and the AI image-match client-wiring sub-project
- Chrome Web Store submission assets (store listing, screenshots, privacy policy, terms of service, permissions justification), none of this exists yet
- Password change and account deletion (explicitly out of scope when the account dashboard was built)
- Moderator/admin override for enrollment (peer confirmation only for now)
- Rejection/decline mechanism for enrollment submissions
- A "my submissions" status UI for enrollees
- Real held-out validation for AI matching rejection thresholds (current thresholds are derived only from closed-set evaluation data)
- A comprehensive security pass (rate limiting audit, input validation consistency audit, crash/error reporting)
- Firefox/Edge support (Chrome-only was the deliberate launch decision)
- A real marketing website (only visual mockups exist, never built as an actual site)

## Tech it's built with

Manifest V3 Chrome extension, vanilla TypeScript (deliberately no framework), shadow-DOM content-script overlay. Backend: Node.js, Express, Prisma, Postgres with pgvector. Auth: email/password with JWT (rotating refresh tokens, hashed at rest). AI matching: a separate Python microservice running DINOv2 as a fixed feature extractor (not fine-tuned), Puppeteer for rendering reference font samples. Testing: Vitest across both the extension and backend.

## Rules that never change

- Never store or redistribute actual font files, only names, small sample crops, and source links
- Never scrape competitor font-matching databases (WhatFontIs, WhatTheFont, or similar), real legal and ToS risk was evaluated and rejected; Google Fonts' public API is the only legitimate automated expansion path
- DOM font resolution must stay fast and local first; server calls happen only as a fallback when local lookup fails, never on the common path, this principle has already been protected twice (Step 4 and Step 6)
- Promoted community-enrolled fonts can never enter the AI image-matching catalog, since there is no real font file to generate embeddings from. This is enforced structurally through the FontEmbedding join, not a flag that could be forgotten
- No em dashes in any output, file, or instruction for this project
- Claude Code instructions are always given in a fenced code block, ready to paste
- All project outputs live in one consistent location, not scattered across directories
