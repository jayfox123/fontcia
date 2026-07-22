# fontCIA — Build Instructions for Claude Code

Paste this into Claude Code inside the `fontcia` root folder to kick off the build. It defines exactly what to build for v1, what to leave for later, and the design decisions already locked.

---

## What fontCIA is

A Chrome extension that lets a user draw a selection box over text on any webpage and identifies the font, linking to where it can be obtained. If the extension doesn't recognize a font, the user can name it and submit it to a shared, moderated database. Long-term this becomes a SaaS product: extension client, backend API, user accounts, saved font library, free/paid tiers.

## Scope for this build: v1 MVP only

Build the **DOM-text detection path only**. Do not build image/video pixel matching, AI embeddings, or a vector database in this phase. That is an intentional, agreed-upon deferral, not an oversight: v1 reads the font straight from the page's CSS (`font-family`, `font-weight`, `font-style`), which is exact, instant, and needs no machine learning. AI-based matching for text inside images and video is a distinct phase 2 project, built after v1 validates demand.

**Chrome only.** Manifest V3. Do not build for Firefox or Safari in this phase.

**Both themes at launch.** Dark and light, with a toggle. Do not ship one and defer the other.

## Tech stack (recommended, confirm/adjust as needed)

- Extension: Manifest V3, TypeScript, a lightweight framework or vanilla TS for the content script UI (React is fine if it keeps the bundle reasonable; avoid over-engineering the popup/overlay)
- Styling: CSS variables/tokens per the palette below, so theme switching is a variable swap, not duplicated styles
- Backend: Node.js (or your preferred stack) exposing a REST API for auth, saved fonts, and font enrollment/moderation
- Database: Postgres. Design the schema now to accommodate the phase 2 AI fields (embedding vector column, etc.) even though nothing writes to them yet, so the migration path is clean later
- Auth: standard email/password or OAuth, whichever is fastest to stand up correctly; must support account-gated features (see below) while allowing anonymous scanning

## Core v1 features

**1. Grid selection.** Clicking the extension icon activates a content script that turns the cursor into a crosshair (CSS `cursor: crosshair`) and overlays a selection layer rendered inside a shadow DOM, so host page styles can't leak in or be affected. Dragging draws a box; releasing locks the selection and opens the scan dialogue anchored near it.

**2. Font detection via DOM.** On scan, resolve the DOM text node(s) under the selection and read the computed `font-family`, `font-weight`, and `font-style`. Match against a known-fonts table (start with Google Fonts metadata, license, and source URL) to return a name and a link to the source (Google Fonts page, Adobe Fonts, or wherever it's licensed). No network round-trip to an ML service is needed for this path; it can resolve almost instantly client-side or via a trivial lookup API.

**3. No-match / unknown font handling.** If the resolved font-family isn't in the known-fonts table, don't dead-end. Show "we don't recognize this one, name it" and route into the enrollment flow from the same dialogue.

**4. Enrollment flow.** Logged-in users can submit a font name plus the sample and (optionally) a source URL. Enforce a minimum sample requirement, not a single letter, since a single glyph is too weak a signal to be useful as a permanent database record. Store submissions in a pending state; require either multiple independent confirmations or manual moderator approval before an entry is promoted to live/matchable. Never store or redistribute an actual font file, only the reference metadata and a small text sample plus source attribution.

**5. Multi-source results.** Data model: a `fonts` table (canonical name, license type, metadata, and a reserved-but-unused embedding column for phase 2) and a separate `sources` table (font_id, url, submitted_by, votes, created_at). One font can have many source rows. When a scan matches a font that has multiple enrolled sources, list all of them, ranked by votes/recency, not just one link.

**6. Accounts.** Support login (required for saving, history, and enrollment; not required for a basic scan, to keep the entry barrier low). On login, sync: saved font library, scan history, submission reputation (used later to weight moderation trust).

**7. Saved library / starring.** A star/save action on any scan result, tied to the user's account, building a personal collection they can revisit without re-scanning. This is the retention mechanic, treat it as core, not an add-on.

**8. Free / Pro tiers (scaffolding only for v1).** Free: 20 scans/month, saved library, community enrollment. Pro: $6/month, unlimited scans, priority moderation, team collections. For v1, implement the scan-count tracking and gating logic; real payment processing (Stripe or similar) can be a thin follow-up once the core product works, but the usage-tracking and rate-limiting plumbing should exist from the start, don't retrofit it later.

## Explicitly out of scope for this build

Do not build any of the following in v1; they are documented for context only, so the architecture doesn't foreclose them later:

- Image or video pixel capture (`chrome.tabs.captureVisibleTab`) and cropping
- Any CNN/embedding model or vector similarity search (FAISS, pgvector queries)
- Single-letter font enrollment as a standalone flow
- Firefox/Edge/Safari builds
- The public marketing website (the SaaS landing page is a separate, later deliverable; a design prototype already exists for reference)

## Design tokens

Ship both themes using CSS variables so switching is trivial.

**Dark (default the extension UI to this):**
- Background base: `#14171A`
- Surface: `#1F242B`
- Text: `#E8E6E1`
- Accent / CTA (scan, save buttons): `#FF6A3D`
- Success / match-confidence: `#3FA796`
- Border: `#2A2F36`

**Light:**
- Background base: `#FFFFFF`
- Surface: `#F4F4F5` (or `#F9F9FA` on the website)
- Text: `#18181B`
- Accent / CTA: keep `#FF6A3D` for brand consistency across themes
- Success / match-confidence: `#16A34A`
- Border: `#E5E5E7`

Use one accent color for actions and a separate color for status/confidence; don't introduce a third accent. The selection box and dialogue chrome render on top of arbitrary page content, so keep them high-contrast regardless of theme (near-black or near-white background with a visible border), not a mid-tone that can wash out against unpredictable page backgrounds.

## Known technical constraints to design around

- Manifest V3 service workers are ephemeral and get killed/restarted by the browser. Any "selection mode active" or in-progress state must persist in `chrome.storage.session`, not in-memory variables, or the crosshair will silently stop working after idle time.
- Content scripts cannot call `chrome.tabs.captureVisibleTab` directly (relevant for phase 2, not v1); that call has to be proxied through the background service worker via messaging. Not needed for v1's DOM-only path, but keep the messaging architecture clean now so phase 2 slots in without a rewrite.

## Suggested build order

1. Extension shell: icon click → crosshair cursor → shadow-DOM selection overlay → locked selection box, no backend yet.
2. Scan dialogue UI: ready / loading / result states, both themes, wired to a mocked response first.
3. DOM font-resolution logic: read computed styles from the selected node(s), match against a seed known-fonts table.
4. Backend API: auth, known-fonts lookup, scan logging (for rate limits), saved-fonts endpoints.
5. Enrollment flow: submission form, pending queue, moderation/confirmation logic, promotion to live.
6. Multi-source results: sources table, ranked list UI.
7. Saved library / scan history UI.
8. Usage tracking and tier gating (Free vs. Pro limits).

Confirm the tech stack choices above before writing code, then proceed phase by phase rather than building everything at once.
