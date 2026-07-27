# fontCIA — Multi-Source Results Design (Step 6)

**Status:** Approved
**Scope:** Build the proper fonts/sources data model deferred since the font-matching-backend sub-project, connect it to Step 5's promoted enrollment submissions so they become findable via the DOM path in future scans, and let a single matched font show multiple ranked sources in the result UI instead of exactly one. Catalog expansion (growing either the DOM's 10-font or the AI's 100-font catalog toward the full ~1,500-font Google Fonts library) is explicitly deferred to a separate follow-up.

## Context

Three threads converge here, each left an explicit gap for this sub-project to close:

- **Step 3** (DOM font resolution) built `ScanSource { url, label, votes }` and `MatchResult.sources: ScanSource[]` as an array from the start, and its own spec explicitly deferred "multi-source ranking/voting logic beyond reusing the existing `ScanSource` shape" to this step. In practice, every font in `known-fonts.ts` and every AI-matched font from `font-matches.ts` has always had exactly one source with `votes` hardcoded to `1` — the array shape exists, but has never held more than one real entry.
- **Step 5** (enrollment flow) built `FontSubmission`/`FontSubmissionConfirmation` and a promotion mechanism (`checkAndPromote`, threshold 3), but promotion only ever flipped `status` to `'promoted'` — nothing made a promoted submission actually findable by a future scan. This was a deliberate, explicitly-stated scope cut in that spec ("data-only... nothing in this sub-project makes a promoted submission actually recognizable in a future scan").
- **The font-matching-backend sub-project** built `Font`/`FontEmbedding` for the AI image-matching path's curated 100-font catalog, explicitly noting the pipeline is "generic over any font list, so expanding later is a data change, not a rebuild" — establishing the precedent this sub-project follows for *not* tackling catalog expansion now.

This sub-project unifies around the existing `Font` table rather than building a second, parallel model, extends it with what DOM matching and multi-source display actually need, and wires Step 5's promotion into it.

## Confirmed decisions

- **Unify around the existing `Font` table.** No new parallel "fonts" model. `Font` gains a `matchKeys` array (for DOM name-matching) and a real `FontSource` table (for multi-source ranking) — both additive, both irrelevant to the AI path's existing 100-font catalog unless populated.
- **Promoted fonts are excluded from AI image-matching structurally, not by a flag.** A promoted `Font` row never gets a `FontEmbedding` row, since enrollment only ever collects a small sample image and name — never a real font file to render and embed from. `/font-matches`' query inner-joins through `FontEmbedding`, so a `Font` with no embeddings is mechanically invisible to it. This is a structural consequence of never running the embedding step, not a boundary that has to be separately maintained or checked — worth stating explicitly here so a future "why doesn't this promoted font show up in image matching" question isn't quietly patched over by trying to embed something there's no real font file for.
- **DOM resolution stays local-first.** `known-fonts.ts` and `findKnownFont()` are completely untouched — still a synchronous, bundled, zero-network first tier. Only when local lookup fails does resolution try one new, slower fallback tier: a server lookup against `Font.matchKeys`, mirroring the exact structure Step 3 already uses for the `'no-text'` reason (which falls through to the AI image-matching pipeline before giving up). The fast path (any of the 10 known fonts) is entirely unaffected; only the already-slow "we don't recognize this" path gets one more chance before landing on the enrollment prompt.
- **Catalog expansion (10 → ~1,500 DOM, 100 → ~1,500 AI) is deferred.** This sub-project is data-model and wiring work; populating either catalog at scale is a separate, orthogonal follow-up, matching the font-matching-backend spec's own precedent. The schema below doesn't block it — expanding later is adding rows, not restructuring.
- **No backfill for the AI catalog's existing 100 `Font` rows.** They keep computing their Google Fonts link ad hoc from `googleSlug` in `font-matches.ts`, exactly as today. `FontSource` is populated only for promoted fonts in this sub-project — migrating the curated catalog's links into stored rows would be a real migration for no behavioral gain.
- **A font with zero sources is valid, not an error state.** If a promoted submission's original sourceUrl was never provided and no confirmer proposed one either, the font is still created and matchable by name — the result UI just shows no source link. Nothing forces at least one source to exist.
- **Richer per-confirmer sourcing, not just the original submitter's link.** Each confirmation may now optionally carry its own proposed `sourceUrl`, independent of the original submission's. At promotion time, every *distinct* proposed URL (from the submission and from every confirmation that supplied one) becomes its own `FontSource`, with `votes` set to how many distinct people proposed that exact URL. This directly extends `FontSubmissionConfirmation` and `POST /font-submissions/:id/confirm` (previously no-body) — an explicit, deliberate reach-back into already-shipped Step 5 work, chosen over the simpler "at most one community source" default because it's what makes "multiple ranked sources" a real, regularly-occurring case rather than a capability that's built but rarely exercised.
- **This reach-back replaces Step 5's sourceUrl-backfill behavior, not just adds to it.** Step 5 originally backfilled a confirming resubmitter's `sourceUrl` onto `FontSubmission.sourceUrl` if the original submission didn't have one. Keeping that *and* adding per-confirmation `sourceUrl` would double-count: a URL backfilled onto the submission and that same confirmer's own confirmation row would both attribute a proposal to it, once correctly (via their confirmation) and once incorrectly (via the submission, which they don't actually own). Instead: `FontSubmission.sourceUrl` is set once at creation and never mutated afterward; every other person's proposed URL — whether via a plain resubmission (`POST /font-submissions`, unchanged trigger) or an explicit confirm with a body — lands on *their own* confirmation row. This is a genuine behavior change to shipped code, not purely additive, and is called out here for that reason. The existing test asserting the old backfill behavior is replaced with one asserting the new per-confirmation attribution.
- **`votes` finally means something.** Previously hardcoded to `1` everywhere it appeared. A promoted font's `FontSource.votes` is the actual count of distinct people who proposed that URL — the field's first real use since it was defined in Step 3.

## Architecture

### New components

```
server/prisma/schema.prisma            — Font gains matchKeys, googleSlug becomes optional, new
                                          FontSource model; FontSubmissionConfirmation gains sourceUrl
server/src/routes/fonts.ts             — new: GET /resolve
server/src/routes/font-submissions.ts  — modified: checkAndPromote creates Font+FontSource on
                                          promotion; POST / stops backfilling onto FontSubmission.sourceUrl,
                                          stores the resubmitter's own sourceUrl on their confirmation
                                          instead; POST /:id/confirm accepts an optional sourceUrl body
server/src/app.ts                      — mounts fontsRouter

src/shared/api-messages.ts             — gains RESOLVE_FONT_NAME; CONFIRM_FONT_SUBMISSION gains sourceUrl
src/background/api-client.ts           — gains resolveFontName; confirmFontSubmission gains a sourceUrl param
src/background/service-worker.ts       — RESOLVE_FONT_NAME case in handleApiMessage

src/content/scan-types.ts              — NoMatchResult gains detectedFontFamily/detectedConfidence,
                                          set only for reason: 'unrecognized'
src/content/font-resolver.ts           — resolveFromReadings stops discarding the detected family/share
                                          for the unrecognized case
src/content/locked-selection.ts        — handleScan's 'unrecognized' branch tries the server fallback
                                          before falling through to the enrollment prompt
src/content/scan-dialogue.ts           — renderEnrollmentFormState's suggestion click now also passes
                                          along whatever the user typed into the source-URL field
src/content/enrollment.ts              — handleConfirmExisting threads that sourceUrl through
```

No changes needed to `renderResultState`/`renderRankedMatchesState`/`showResult` — they already render `sources` as a list generically; they've simply never been handed more than one entry.

### Database schema

```prisma
model Font {
  id         String          @id @default(uuid())
  name       String          @unique
  googleSlug String?         // CHANGED: was required — promoted fonts have no Google Fonts slug
  category   String?
  matchKeys  String[]        @default([])   // NEW — populated only for promoted fonts in this sub-project
  embeddings FontEmbedding[]
  sources    FontSource[]    // NEW
}

model FontSource {
  id        String   @id @default(uuid())
  fontId    String
  font      Font     @relation(fields: [fontId], references: [id])
  url       String
  label     String   // the URL's hostname, e.g. "fonts.adobe.com" — simple, honest, no guessing at branding
  votes     Int      @default(1)
  createdAt DateTime @default(now())
}

model FontSubmissionConfirmation {
  id           String         @id @default(uuid())
  submissionId String
  submission   FontSubmission @relation(fields: [submissionId], references: [id])
  confirmedBy  String
  confirmer    User           @relation(fields: [confirmedBy], references: [id])
  sourceUrl    String?        // NEW — this confirmer's own proposed source, independent of the submission's
  createdAt    DateTime       @default(now())

  @@unique([submissionId, confirmedBy])
}
```

`googleSlug` becoming optional is safe for the AI path: `/font-matches`' query only ever returns rows that have a `FontEmbedding`, and only the curated catalog (which always sets `googleSlug`) ever gets embedded — a promoted font can never appear in that result set to begin with, so the raw query's manually-typed row shape doesn't need to change.

### Promotion logic (`checkAndPromote`, in `font-submissions.ts`)

Runs after any confirmation-adding operation (resubmission-as-confirmation or explicit confirm), unchanged trigger. Once `1 + confirmations.length` reaches `CONFIRMATION_THRESHOLD` (still 3):

1. Collect every distinct proposed URL: the submission's own `sourceUrl` (attributed to `submittedBy`) plus every confirmation's `sourceUrl` where present (attributed to that `confirmedBy`). Group by exact URL string; each group's size is that URL's vote count.
2. In a transaction: find-or-create a `Font` row by case-insensitive name match (guards the rare case where an earlier submission with the same name was already promoted and a later, independently-created submission reaches threshold too — reuses the existing `Font` rather than violating its unique-name constraint), with `matchKeys: [fontName.toLowerCase()]` if newly created.
3. For each distinct proposed URL not already represented by a `FontSource` on that font, create one with `votes` = its proposer count and `label` = the URL's hostname.
4. Set the submission's `status` to `'promoted'`.

A submission with no sourceUrl anywhere among itself and its confirmations still promotes — it just yields a `Font` with zero `FontSource` rows.

### New server endpoint

**`GET /fonts/resolve?name=<raw CSS font-family stack>`** (`optionalAuth`, matching `/font-matches`' precedent; no rate limiting, consistent with that route also having none for a costlier operation).

Runs the same comma-split → trim → strip-quotes → lowercase candidate extraction `findKnownFont` already does client-side, iterating candidates in order and querying `Font.matchKeys` (Prisma's `hasSome` array filter) for the first one that matches. Returns `200 { fontName, sources }` (sources sorted by `votes` desc) or `404`.

### `POST /font-submissions` — behavior change

The resubmission-as-confirmation branch (an existing pending match found, caller isn't the original submitter) no longer backfills `existing.sourceUrl`. Instead, the resubmitter's own `sourceUrl` (from their own request body) is stored on their own `FontSubmissionConfirmation` row, upserted exactly as `confirmedBy` already is. Self-resubmission (caller is the original submitter) remains an unchanged no-op.

### `POST /font-submissions/:id/confirm` — behavior change

Now accepts an optional JSON body: `{ sourceUrl?: string }`, validated with the same `new URL(...)` check `POST /` already applies. If present, it's stored on the upserted confirmation row (skipped on a repeat confirm call that supplies no URL, so re-confirming without a body never erases a previously-supplied one). Omitting the body entirely preserves today's exact behavior.

### Client message contracts

```ts
// src/shared/api-messages.ts additions
| { type: 'RESOLVE_FONT_NAME'; fontFamilyStack: string }

// CONFIRM_FONT_SUBMISSION, modified:
| { type: 'CONFIRM_FONT_SUBMISSION'; id: string; sourceUrl: string | null }
```

`api-client.ts` gains `resolveFontName(fontFamilyStack)` (goes through the existing `apiFetch`, `auth: 'optional'` — matching `logScan`'s precedent of attaching a token when one exists without requiring one). `confirmFontSubmission` gains a second `sourceUrl: string | null` parameter, included in the POST body.

### Client resolution flow

`scan-types.ts`'s `NoMatchResult` gains two fields, set only when `reason: 'unrecognized'`:

```ts
export interface NoMatchResult {
  status: 'no-match';
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
  detectedFontFamily?: string;   // the raw CSS font-family stack that failed local lookup
  detectedConfidence?: number;   // the same majority-share percentage a known-font match would have gotten
}
```

`font-resolver.ts`'s `resolveFromReadings` stops discarding the winning reading's `fontFamily` and `share` when `findKnownFont` returns null — both were already computed at that point, just never returned.

`locked-selection.ts`'s `handleScan`: the existing `logScanResult(result)` call still fires immediately and unconditionally (still logs `'no-match'` for this scan attempt, exactly as today — mirroring the `'no-text'` branch's identical two-log pattern, where an initial no-match log is followed by a second, corrected log if a fallback tier later succeeds). Then, for `reason: 'unrecognized'` specifically: if `detectedFontFamily` is present, send `RESOLVE_FONT_NAME` before rendering anything new (the loading spinner already on screen from `renderLoadingState` simply persists through this — no new loading copy, since this is a quick DB lookup, not the AI path's meaningfully slower image analysis). On success, render a normal match result (`fontName`/`sources` from the response, `confidence` from the already-carried `detectedConfidence`) and fire a second `LOG_SCAN` with `status: 'match'`. On failure — not-found or a network hiccup, deliberately not distinguished, since both should safely fall through rather than hang — render `renderUnrecognizedFontState` exactly as today.

### Client UI — confirming an existing suggestion now proposes a source too

`renderEnrollmentFormState` already has a source-URL input on the form (used today only when submitting a brand-new font). Clicking an existing suggestion now also reads that same input's current value (trimmed, `null` if empty — identical normalization to the Submit button's existing handling) and passes it through: `onConfirmExisting(id, sourceUrl)`. No new UI element — the same field just applies to both submission paths. `enrollment.ts`'s `handleConfirmExisting` threads this through to the `CONFIRM_FONT_SUBMISSION` message.

## Testing

Same established split: server-side normalization/threshold/promotion logic gets real tests against real Postgres (no mocking, consistent with every prior server sub-project); client-side message-dispatch and render logic gets tests against mocked `chrome.runtime` (consistent with every prior client sub-project). The existing Step 5 test asserting sourceUrl-backfill-onto-the-submission is replaced with one asserting per-confirmation attribution instead. New coverage: `checkAndPromote` creating a `Font` + correctly-deduped, correctly-voted `FontSource` rows (including the zero-sources case and the reused-existing-Font edge case); `GET /fonts/resolve` matching/case-insensitivity/404; the DOM fallback's success, not-found, and network-error paths, and that it doesn't fire for `'mixed'`/`'no-text'`/`'error'` reasons.

## Out of scope for this spec

Catalog expansion for either the DOM or AI catalog (a separate follow-up). Fuzzy/typo-tolerant name matching in `/fonts/resolve` (exact matchKey match only, same as `findKnownFont` today). A distinct loading-state message for the server-fallback tier. Backfilling `FontSource` rows for the AI catalog's existing 100 fonts. Any change to how the AI image-matching path selects or ranks sources. Deduplicating or merging `Font` rows beyond the single reused-existing-row case described above. A UI affordance for removing or disputing a previously-proposed source. Moderator approval, rejection handling, or a submissions-status UI (already out of scope from Step 5, unchanged here).
