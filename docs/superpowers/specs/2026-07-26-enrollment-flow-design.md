# fontCIA — Enrollment Flow Design (Step 5)

**Status:** Approved
**Scope:** Wire up the "Name it" button (disabled since Step 2) so a logged-in user can submit an unrecognized font's name and an optional source URL, reusing the screenshot crop already captured during that scan attempt as the submission's sample. Submissions require multiple independent confirmations before being marked "promoted." **Data-only** — nothing in this sub-project makes a promoted submission actually recognizable in a future scan; that's a separate follow-up.

## Context

`renderNoMatchState` in `scan-dialogue.ts` has rendered a permanently-`disabled = true` "Name it" button since the very first scan-dialogue implementation. This sub-project makes it real. It reuses two things already built: the `CAPTURE_SELECTION` capture-and-crop mechanism (image-capture-pipeline sub-project) for the DOM path, and the `MATCH_IMAGE` round trip's already-in-hand `Blob` (image-match-client-wiring sub-project) for the AI path.

A key finding shaped this spec's scope: `findKnownFont()` — what actually recognizes fonts on the DOM path — is a static, bundled, purely client-side array with zero backend involvement. So "promoted to live/matchable" has two very different possible meanings: (A) a submission reaches a durable "promoted" status in the database, or (B) promoted fonts become checkable in real time by `findKnownFont()`, which means redesigning it from a static bundled array into something backend-fetched-and-cached — a genuinely separate redesign with no relation to enrollment itself. This spec is **(A) only**, matching this whole project's established "simplest viable slice, defer the next layer" pattern (DOM-only before AI, capture-only before matching, etc.). (B) is explicitly deferred.

## Confirmed decisions

- **Confirmation mechanism: multiple independent confirmations, not moderator approval.** No role/admin/moderator infrastructure exists anywhere in this codebase. Building it (a `role` field, moderator-only middleware, a moderation UI) is a separate, unrelated chunk of work with no other use yet — confirmation-by-resubmission needs none of it.
- **Discoverability fix**: rather than relying on two users coincidentally typing the exact same font name (which would make confirmations rare in practice), the enrollment form fetches the full list of pending submissions once when it opens and live-filters it client-side as the user types, surfacing existing entries as pickable suggestions ("Confirm as: *Brandon Grotesque* — 2 confirmations so far"). Picking one confirms that exact submission by id; typing something not in the list and submitting starts a new one. Thumbnail previews in the suggestion list (so users could visually verify a match, not just match on name) are a reasonable future enhancement, deferred for v1.
- **Sample reuse, different mechanics per path**: DOM path ('unrecognized' reason only) triggers `CAPTURE_SELECTION` on demand from the "Name it" click (no capture has happened yet at that point). AI path (no-confident-match state) reuses the `Blob` already in scope from the just-completed `MATCH_IMAGE` round trip — no new capture at all.
- **Enrollment is reachable from 'unrecognized' only, not 'mixed' or 'error'.** 'mixed' has no single font-family value to name (DOM sampling found multiple different fonts across the selection with no majority); 'error' resolved nothing at all. Both keep their exact current behavior (`renderNoMatchState`, permanently-disabled "Name it") — completely untouched by this sub-project.
- **Sample image stored as `Bytes` directly in Postgres** — no new blob-storage infrastructure. These are small crops, the same scale as what already flows through `/font-matches`.
- **Confirmations are lightweight join rows** (who + when) — not a duplicated sample image per confirmation. The original submission's sample is the canonical one.
- **No rejection status, no moderator gate in v1** — a submission either sits pending or reaches `'promoted'`; nothing builds a path to `'rejected'`, so that status value isn't added to the schema at all (no unused enum value implying unbuilt functionality).
- **`POST /font-submissions` requires real auth** (`requireAuth`, not `optionalAuth`) — matching `saved-fonts.ts`'s exact precedent, since an anonymous enrollment would have no accountable submitter for the confirmation-counting scheme to work against.
- **"Name it" follows the exact same logged-in/logged-out conditional already established for Save buttons** — enabled when logged in, a "Log in to name it"-style prompt when not — rather than being unconditionally disabled regardless of auth state as it is today.
- **Self-confirmation is blocked**: a user cannot confirm their own pending submission. Without this guard, a submitter could reach the threshold with fewer independent supporters than intended, undermining the whole point of requiring *multiple* people to agree.
- **Confirmation count is computed via a relation-count query**, not a stored/denormalized counter column — avoids an entire class of sync bugs between a counter and its underlying rows.

## Architecture

### New components

```
server/prisma/schema.prisma            — new Font Submission, FontSubmissionConfirmation models
server/src/routes/font-submissions.ts  — new: POST /, GET /pending, POST /:id/confirm
server/src/app.ts                      — mounts fontSubmissionsRouter

src/shared/api-messages.ts             — gains GET_PENDING_SUBMISSIONS, CONFIRM_FONT_SUBMISSION
src/shared/submission-messages.ts      — new: SubmitFontMessage, SubmitFontResponse (carries a Blob,
                                          kept separate from api-messages.ts for the same reason
                                          match-messages.ts and capture-messages.ts are separate:
                                          apiFetch/rawRequest is JSON-only)

src/background/api-client.ts           — gains getPendingSubmissions, confirmFontSubmission, submitFont
src/background/service-worker.ts       — gains a SUBMIT_FONT onMessage branch (mirroring the
                                          existing MATCH_IMAGE branch) + two new handleApiMessage cases

src/content/scan-dialogue.ts           — new: renderUnrecognizedFontState (DOM path's enhanced
                                          no-match state with a real "Name it"), renderEnrollmentFormState,
                                          renderEnrollmentSubmittedState; modified: renderNoConfidentMatchState
                                          gains the same "Name it" entry point
src/content/locked-selection.ts        — modified: handleScan's dispatch distinguishes 'unrecognized'
                                          from 'mixed'/'error'; new enrollment handler functions
src/content/theme.ts                   — new CSS for the enrollment form's inputs and suggestion list
```

### Database schema

```prisma
model FontSubmission {
  id            String   @id @default(uuid())
  fontName      String
  sourceUrl     String?
  sampleImage   Bytes
  submittedBy   String
  submitter     User     @relation(fields: [submittedBy], references: [id])
  status        String   // 'pending' | 'promoted'
  createdAt     DateTime @default(now())
  confirmations FontSubmissionConfirmation[]
}

model FontSubmissionConfirmation {
  id           String         @id @default(uuid())
  submissionId String
  submission   FontSubmission @relation(fields: [submissionId], references: [id])
  confirmedBy  String
  confirmer    User           @relation(fields: [confirmedBy], references: [id])
  createdAt    DateTime       @default(now())

  @@unique([submissionId, confirmedBy])
}
```

`User` gains two new back-relations (`fontSubmissions FontSubmission[]`, `fontSubmissionConfirmations FontSubmissionConfirmation[]`) — no other change to `User`.

### API contract

**`POST /font-submissions`** (`requireAuth`, multipart: `fontName`, optional `sourceUrl`, `image` file — same `multer` memory-storage pattern as `/font-matches`, same 10MB limit)

Validates `fontName` non-empty, `sourceUrl` (if present) passes a `new URL(...)` check, `image` present. Server-side dedup: looks up an existing **pending** submission with a case-insensitive exact match on the trimmed `fontName` (Postgres/Prisma's `mode: 'insensitive'` string filter — no raw SQL needed) as a secondary safety net beneath the client-side suggestion list.

- If a match exists and the caller is its own submitter: no-op, return its current state (handles a user accidentally resubmitting their own pending entry).
- If a match exists and the caller is someone else: upsert a `FontSubmissionConfirmation` (idempotent — a second click doesn't error), backfill `sourceUrl` only if the existing submission doesn't already have one, run the promotion check, return `200 {submissionId, status}`.
- If no match: create a new `FontSubmission` with `status: 'pending'`, return `201 {submissionId, status: 'pending'}`.

**`GET /font-submissions/pending`** (`requireAuth`) — returns `{submissions: [{id, fontName, confirmationCount}]}` for every currently-pending submission, no pagination (v1 scale doesn't need it). `confirmationCount` is `1 + confirmations.length` (the submitter counts as the first supporter).

**`POST /font-submissions/:id/confirm`** (`requireAuth`, no body) — the "I picked an existing suggestion" path.

- `404` if the submission doesn't exist or isn't `'pending'`.
- `400` if the caller is the submission's own submitter.
- Otherwise upsert a `FontSubmissionConfirmation` (idempotent), run the promotion check, return `200 {status, confirmationCount}`.

**Promotion check** (shared helper, run after any confirmation-adding operation): count `1 + confirmations.length`; if it reaches `CONFIRMATION_THRESHOLD` (proposing **3** — the submitter plus 2 independent confirmers — explicitly flagged as an unvalidated starting point, the same treatment `BLACKNESS_THRESHOLD`/`MARGIN_THRESHOLD` got elsewhere in this project), set `status: 'promoted'`.

### Client message contracts

```ts
// src/shared/api-messages.ts additions (plain JSON, no Blob — fit the existing ApiMessage union)
| { type: 'GET_PENDING_SUBMISSIONS' }
| { type: 'CONFIRM_FONT_SUBMISSION'; id: string }
```

```ts
// src/shared/submission-messages.ts (new — carries a Blob, same reasoning as match-messages.ts)
export interface SubmitFontMessage {
  type: 'SUBMIT_FONT';
  fontName: string;
  sourceUrl: string | null;
  blob: Blob;
}

export type SubmitFontResponse =
  | { status: 'ok'; submissionId: string }
  | { status: 'error'; message: string };
```

`api-client.ts` gains `getPendingSubmissions()` and `confirmFontSubmission(id)` (both go through the existing `apiFetch`/`rawRequest` JSON path, `auth: 'required'`) and `submitFont(fontName, sourceUrl, blob)` (bypasses `apiFetch` for a multipart body, mirroring `matchImage`'s exact precedent — including the same auth caveat that decision already documented: this doesn't attach a stored access token the way `apiFetch` would, since it doesn't go through it — **this needs fixing here**, unlike `matchImage`, because `/font-submissions` uses `requireAuth`, not `optionalAuth`; `submitFont` must read the stored auth token itself and attach `Authorization: Bearer <token>` manually, or the request will always 401 regardless of login state).

`service-worker.ts`'s `onMessage` listener gains a `SUBMIT_FONT` branch (mirroring the existing `MATCH_IMAGE` branch exactly, including wrapping the call in a try/catch per the same "never let a rejection hang the content script" reasoning already fixed for `handleMatchImageMessage`), and `handleApiMessage`'s switch gains `GET_PENDING_SUBMISSIONS`/`CONFIRM_FONT_SUBMISSION` cases.

### Client UI flow

**DOM path**: `handleScan`'s dispatch (`locked-selection.ts`) changes from routing `'unrecognized'`/`'mixed'`/undefined-reason/`'error'` all into the same `renderNoMatchState(body, onRestart)` call, to routing `'unrecognized'` specifically into a new `renderUnrecognizedFontState` (same message copy, but with a real, conditionally-enabled "Name it" button following the isLoggedIn/onLoginPrompt pattern already established for Save buttons) while `'mixed'`/`'error'`/undefined stay on the exact current `renderNoMatchState` call, completely unchanged.

Clicking "Name it" (DOM path) → `renderEnrollmentFormState` (fetches the pending list via `GET_PENDING_SUBMISSIONS`, shows the name/source-URL inputs with live-filtered suggestions, a submit button, a cancel path back to the ready/no-match state) → on submit with a typed new name: trigger `CAPTURE_SELECTION` (reusing the existing rect already in closure scope, exactly as `handleNoTextResult` already does) → on successful capture, send `SUBMIT_FONT` with the fresh blob → `renderEnrollmentSubmittedState`. On a picked suggestion instead: skip capture entirely, send `CONFIRM_FONT_SUBMISSION` directly → `renderEnrollmentSubmittedState`. Capture failure reuses `renderCaptureBlockedState` (the situation — "we can't get a screenshot of this" — is identical to the AI path's existing use of that same state).

**AI path**: `renderNoConfidentMatchState` gains the same isLoggedIn/onLoginPrompt-conditional "Name it" button. Clicking it goes straight to `renderEnrollmentFormState` — no capture step, since `handleImageCapture`'s `blob` parameter is still in scope and gets threaded straight into `SUBMIT_FONT` on submit (or `CONFIRM_FONT_SUBMISSION` on a picked suggestion, which needs no blob at all).

## Testing

Matches this project's established split throughout: normalization, threshold, and validation logic (server) and message-dispatch/render logic (client) are fully unit-testable and get real tests, using real Postgres for the server side (no DB mocking, consistent with every prior server sub-project) and mocked `chrome.runtime` for the client side (consistent with every prior client sub-project). No new untestable browser/network glue is introduced beyond what `CAPTURE_SELECTION`/`MATCH_IMAGE` already established and already have their own coverage.

## Out of scope for this spec

Making promoted submissions actually recognizable in a future scan (redesigning `findKnownFont()` to be backend-driven) — a separate follow-up sub-project. Moderator/admin approval as an alternative or additional gate. A rejection/decline mechanism. A "my submissions" status UI for the submitter to check on their own pending entries. Wiring enrollment into the `'mixed'` or `'error'` no-match reasons. Thumbnail previews in the pending-suggestions list. Pagination or search on `GET /font-submissions/pending`.
