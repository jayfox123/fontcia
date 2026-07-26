# fontCIA — Image Match Client Wiring Design (Sub-project 3 of AI Image Matching phase)

**Status:** Approved
**Scope:** Wire the capture pipeline's cropped image `Blob` (currently held in a closure variable and discarded, per the "Analyzing image…" placeholder) to the real `POST /font-matches` endpoint from the just-merged matching backend, and replace the placeholder with a real, honestly-uncertain ranked-candidates UI.

## Context

The image-capture-pipeline sub-project built the capture-and-crop plumbing: when DOM font-resolution finds no text (`NoMatchResult.reason === 'no-text'`), `locked-selection.ts`'s `handleNoTextResult()` captures and crops a screenshot, holds the resulting `Blob` in a `capturedImageBlob` closure variable, logs it, and leaves the UI frozen on "Analyzing image…" — with an explicit comment that a future sub-project would consume it. The font-matching-backend sub-project then built and validated `POST /font-matches` against a real 100-font catalog: **Top-1 31%, Top-3 45%, Top-5 56%** accuracy, with a margin-based rejection (empty `matches` array) for cases where no candidate clearly stands out. This sub-project connects the two and builds the UI those real numbers demand.

The existing single-answer `MatchResult` UI (`renderResultState` in `scan-dialogue.ts`) was built for the DOM path, where a match means "we read this font's exact CSS value" — genuine certainty. Presenting a 31%-accurate top-1 guess through that same UI would misrepresent it as similarly reliable. This sub-project's UI must honestly reflect real uncertainty: a ranked list of candidates, not one confident-looking answer.

## Confirmed decisions

- **A new message type, not an extension of `ApiMessage`.** `src/shared/match-messages.ts` (sibling to the existing `src/shared/capture-messages.ts`) carries the `Blob` from content script to background script. `ApiMessage`'s transport (`apiFetch`/`rawRequest` in `src/background/api-client.ts`) hardcodes `JSON.stringify` for the request body — it has no multipart/`FormData` support, and the new `/font-matches` endpoint expects `multipart/form-data` with an `image` field (via `multer`). Rather than teaching the shared JSON transport about a one-off exception, this mirrors the same reasoning that already split capture messages out from API messages: a genuinely different payload shape gets a genuinely different, purpose-built contract.
- **The actual outbound fetch happens in the background script**, in a new `matchImage(blob: Blob)` function in `api-client.ts`, alongside `saveFont`/`deleteSavedFont`/`logScan` — consistent with every other backend call in this codebase living there, even though (unlike `chrome.tabs.captureVisibleTab`) a content script could technically call `fetch` directly. Centralizing all backend calls in one place was worth more than the marginal savings of skipping one message round-trip.
- **A parallel result type, not an extension of `ScanResult`/`MatchResult`.** The DOM path's types model "one confident CSS read" — stretching them to also mean "1-5 uncertain candidates" would blur two genuinely different situations. A new `ImageMatchResult` type (defined below) keeps the DOM path's existing, already-tested types completely untouched.
- **Three new, distinctly-named UI states**, each reusing existing CSS primitives (`.fontcia-btn`, `.fontcia-source-link`, `.fontcia-result-actions`, `.fontcia-spinner`) but with their own render functions and copy — matching this codebase's established pattern of not conflating different situations under one function just because they look similar (e.g. `renderCaptureBlockedState` already exists as its own function rather than reusing `renderNoMatchState`):
  - **Ranked matches** (`renderRankedMatchesState`): a list of 1-5 candidate cards, each independently saveable.
  - **No confident match** (`renderNoConfidentMatchState`): the backend's empty-array rejection case. Explicitly different copy from the DOM path's "We don't recognize this one." — that message means "we read a font name and don't know it"; this means "we analyzed a real image and found no reliable answer." Conflating them would be dishonest about what actually happened.
  - **Match error** (`renderMatchErrorState`): the `/font-matches` call itself failed (network/backend error) — distinct from `renderCaptureBlockedState`, which is specifically about the *screenshot capture* failing (DRM/blackout detection), not the matching call.
- **Loading state is unchanged**: `renderAnalyzingImageState` (spinner + "Analyzing image…", already shown the instant capture starts) covers the whole capture → match sequence as one continuous experience. No new "Capturing…" / "Matching…" split, no artificial minimum-duration floor — this path has real, sometimes-nontrivial latency (screenshot capture + a network round trip to `/font-matches`, which itself calls the embedding service and runs a DB query), so unlike the DOM path's near-instant resolution, there's no flash-of-spinner problem to guard against. If real-world latency ever feels confusing without more granular feedback, a two-stage split is a cheap follow-up — not needed for v1.
- **Each ranked candidate is independently saveable**, reusing the existing `SAVE_FONT` message and `saveFont()` function completely unchanged — it already accepts exactly `{fontName, confidence, sources}` per call, which is exactly the shape of one `RankedMatch`. No backend or message-contract changes needed for saving. Each candidate card tracks its own saved/pending UI state independently (an array of per-index state), not the DOM path's single `savedFontId` variable.
- **Scan logging is reused unchanged, with a disclosed gap.** The existing `LOG_SCAN` message (`{status: 'match'|'no-match', fontName?, confidence?}`) and `logScan()` function are reused as-is: log the top-ranked candidate as `status: 'match'` when the array is non-empty, `status: 'no-match'` when empty — same fire-and-forget pattern as the DOM path (`sendApiMessage(message).catch(...)`, not awaited before continuing UI work).
  - **Known technical debt, explicitly flagged here so it isn't lost:** this means the `/scans` table cannot distinguish a DOM path's high-confidence CSS read from this path's 31%-accurate AI guess — both currently land as an indistinguishable `status: 'match'` row. Adding a source/path discriminator column to `/scans` (e.g. `source: 'dom' | 'image'`) would fix this, but is a real schema change to the already-shipped 4a scans backend, out of scope for this sub-project. Anyone later analyzing scan-quality data or building analytics on `/scans` needs to know this gap exists before trusting aggregate match-rate numbers.

## Architecture

### New components

```
src/shared/
  match-messages.ts          — new: MatchImageMessage, MatchImageResponse, RankedMatch

src/content/
  scan-types.ts               — gains: ImageMatchResult (new, parallel to ScanResult)
  scan-dialogue.ts            — gains: renderRankedMatchesState, renderNoConfidentMatchState, renderMatchErrorState
  locked-selection.ts         — modified: handleNoTextResult now consumes the Blob instead of discarding it
  theme.ts                    — gains: .fontcia-match-list, .fontcia-match-item, and related new classes

src/background/
  api-client.ts                — gains: matchImage(blob: Blob): Promise<ApiResponse<RankedMatch[]>>
  service-worker.ts            — gains: a third onMessage branch for MATCH_IMAGE, alongside CAPTURE_SELECTION
```

### Message contract (`src/shared/match-messages.ts`)

```ts
import type { ScanSource } from '../content/scan-types';

export interface RankedMatch {
  fontName: string;
  confidence: number;
  sources: ScanSource[];
}

export interface MatchImageMessage {
  type: 'MATCH_IMAGE';
  blob: Blob;
}

export type MatchImageResponse =
  | { status: 'ok'; matches: RankedMatch[] }
  | { status: 'error'; message: string };
```

`RankedMatch` deliberately mirrors the backend's `{fontName, confidence, sources}` response shape exactly — no client-side reshaping needed.

### Result type (`src/content/scan-types.ts` addition)

```ts
export type ImageMatchResult =
  | { status: 'matches'; candidates: RankedMatch[] }
  | { status: 'no-confident-match' }
  | { status: 'error' };
```

Note `RankedMatch` is imported from `match-messages.ts` here, not redefined.

### Background wiring

`api-client.ts` gains a function alongside the existing `saveFont`/`deleteSavedFont`/`logScan`:

```ts
export async function matchImage(blob: Blob): Promise<ApiResponse<RankedMatch[]>> {
  const formData = new FormData();
  formData.append('image', blob, 'crop.png');

  // Bypasses apiFetch/rawRequest — those hardcode JSON.stringify + a
  // Content-Type: application/json header, incompatible with the
  // multipart/form-data body multer expects on this one endpoint.
  const res = await fetch(`${API_BASE_URL}/font-matches`, { method: 'POST', body: formData });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: body?.error ?? `Request failed (${res.status})` };
  }

  const data = (await res.json()) as { matches: RankedMatch[] };
  return { ok: true, data: data.matches };
}
```

(`API_BASE_URL` is whatever constant `rawRequest` already uses — this reuses it, just skips the JSON-specific wrapper around it. Auth: the endpoint uses `optionalAuth`, so no `Authorization` header handling is needed here — matching how `logScan` already calls the equivalent `optionalAuth`-backed `/scans` endpoint without auth headers.)

`service-worker.ts`'s `onMessage` listener gains a third branch:

```ts
chrome.runtime.onMessage.addListener(
  (message: ApiMessage | CaptureSelectionMessage | MatchImageMessage, sender, sendResponse) => {
    if (message.type === 'CAPTURE_SELECTION') {
      handleCaptureMessage(message, sender).then(sendResponse);
    } else if (message.type === 'MATCH_IMAGE') {
      handleMatchImageMessage(message).then(sendResponse);
    } else {
      handleApiMessage(message).then(sendResponse);
    }
    return true;
  },
);
```

where `handleMatchImageMessage` calls `matchImage(message.blob)` and maps the `ApiResponse<RankedMatch[]>` into a `MatchImageResponse`.

### Content script wiring (`locked-selection.ts`)

`handleNoTextResult()`'s capture-success branch changes from discarding the Blob to consuming it:

```ts
if (response.status === 'captured') {
  const message: MatchImageMessage = { type: 'MATCH_IMAGE', blob: response.blob };
  chrome.runtime
    .sendMessage(message)
    .then((matchResponse: MatchImageResponse) => {
      if (disposed) return;
      const result: ImageMatchResult =
        matchResponse.status === 'ok'
          ? matchResponse.matches.length > 0
            ? { status: 'matches', candidates: matchResponse.matches }
            : { status: 'no-confident-match' }
          : { status: 'error' };
      logImageMatchResult(result); // fire-and-forget, mirrors logScanResult
      renderImageMatchResult(result); // dispatches to one of the three new render* functions
    })
    .catch((error: unknown) => {
      if (disposed) return;
      console.error('fontCIA: image match message failed', error);
      renderMatchErrorState(body, onRestart);
    });
}
```

The `capturedImageBlob` closure variable and its "held for a future sub-project" comment are removed — this sub-project *is* that future consumer, and the Blob is now used immediately rather than stored.

`logImageMatchResult` and `renderImageMatchResult` above are two new content-script-local helper functions inside `locked-selection.ts` (not exported, same visibility as the existing `logScanResult`/`showResult`/`handleNoTextResult`):
- `logImageMatchResult(result: ImageMatchResult): void` — mirrors `logScanResult`'s existing shape exactly: maps `{status: 'matches', candidates}` (non-empty) to `LOG_SCAN {status: 'match', fontName: candidates[0].fontName, confidence: candidates[0].confidence}`, and both `{status: 'no-confident-match'}` and `{status: 'error'}` to `LOG_SCAN {status: 'no-match'}`. Fire-and-forget via `sendApiMessage(...).catch(...)`, exactly like `logScanResult`.
- `renderImageMatchResult(result: ImageMatchResult): void` — a small dispatcher, parallel to how `handleScan` already dispatches on `ScanResult`'s status/reason: `'matches'` → `renderRankedMatchesState(body, result.candidates, ...)`, `'no-confident-match'` → `renderNoConfidentMatchState(body, onRestart)`, `'error'` → `renderMatchErrorState(body, onRestart)`.

### UI states (`scan-dialogue.ts` additions)

**`renderRankedMatchesState`** — signature mirrors `renderResultState`'s parameter shape but takes an array and per-candidate saved state:

```ts
export function renderRankedMatchesState(
  body: HTMLElement,
  candidates: RankedMatch[],
  savedFlags: boolean[],       // parallel array, one per candidate
  onToggleSave: (index: number) => void,
  onNewScan: () => void,
  isLoggedIn: boolean,
  onLoginPrompt: () => void,
): void
```

Renders a `.fontcia-match-list` containing one `.fontcia-match-item` per candidate (font name, confidence, sources list, its own save/login-to-save button — same conditional logic `renderResultState` already has for logged-out users), followed by a single shared "New scan" button.

**`renderNoConfidentMatchState(body, onNewScan)`** — same visual shape as `renderNoMatchState` (reuses `.fontcia-no-match-message` styling) but with distinct copy: *"Couldn't find a confident match for this font."* No "Name it" button (that button is already dead/disabled in the DOM path's version — not worth propagating a disabled placeholder into a second state).

**`renderMatchErrorState(body, onNewScan)`** — copy: *"Something went wrong analyzing this image."* Same `.fontcia-no-match-message` + "New scan" button shape as the above two.

### New CSS (`theme.ts`)

```css
.fontcia-match-list { display: flex; flex-direction: column; gap: 12px; max-height: 280px; overflow-y: auto; }
.fontcia-match-item { display: flex; flex-direction: column; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--fontcia-border); }
.fontcia-match-item:last-child { border-bottom: none; }
.fontcia-match-name { font-size: 14px; font-weight: 600; color: var(--fontcia-text); }
.fontcia-match-confidence { font-size: 12px; color: var(--fontcia-text-secondary); }
```

(Exact values are a starting point for the implementer to refine against the existing panel's actual dimensions — the panel's current width/max-height constraints, set elsewhere in `theme.ts`, aren't being changed by this sub-project.)

## Testing

- **Message-passing and render logic**: Vitest + jsdom, mocking `chrome.runtime.sendMessage`, matching this project's established pattern for every prior sub-project's content-script tests (`locked-selection.test.ts`, `scan-dialogue.test.ts`).
- **`matchImage()`**: mock global `fetch` (matching `embedding-client.test.ts`'s server-side precedent and this file's sibling functions' existing test treatment), covering: success with 0/1/5 matches, non-2xx response, network rejection.
- **No real backend/network calls in tests** — the `/font-matches` endpoint itself was already validated end-to-end in the font-matching-backend sub-project; this sub-project's tests only need to verify the client correctly calls it and correctly renders whatever shape comes back.

## Out of scope for this spec

Adding a source/path discriminator to `/scans` (see "known technical debt" above). Any change to the DOM path's existing `MatchResult`/`ScanResult`/`renderResultState` — those are untouched. Any change to the matching backend itself (confidence formula, rejection threshold, catalog size) — that was finalized in the prior sub-project. A "Capturing…" vs. "Matching…" two-stage loading split. Any UI for browsing/comparing saved fonts beyond the existing saved-fonts list (unaffected by this sub-project). Retrying a failed match without re-capturing (the Blob is not retained after use).
