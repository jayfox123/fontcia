# fontCIA — Image Capture Pipeline Design (Sub-project 1 of AI Image Matching phase)

**Status:** Approved
**Scope:** When DOM font-resolution finds zero text under a locked selection (the existing `NoMatchResult.reason === 'no-text'` case), capture the visible tab, crop client-side-triggered/background-executed to the selection rectangle, detect and gracefully handle DRM-blacked-out captures, and hold the resulting image in memory. **No actual image matching, AI model, or backend upload in this sub-project** — this is capture-and-crop plumbing only, laying groundwork for a follow-up matching sub-project.

## Context

Steps 1–3 (merged) built DOM-based font detection: a 5×5 grid of sample points reads `font-family`/`font-weight`/`font-style` directly from the page's CSS wherever it finds text. `NoMatchResult.reason: 'no-text'` already fires, live and correct, exactly when all 25 grid points find nothing readable (`readings.length === 0` in `font-resolver.ts`'s `resolveFromReadings`) — this happens when the user's selection is over an image, video frame, or canvas with no DOM text underneath it, which is precisely the case where AI-based image matching (a distinct, later sub-project) would apply instead. `CLAUDE_CODE_INSTRUCTIONS.md`'s original v1 scope note explicitly deferred "image/video pixel capture and cropping" and "any CNN/embedding model or vector similarity search" as a phase-2 concern, while flagging one forward-looking constraint to design around: `chrome.tabs.captureVisibleTab` cannot be called from a content script and must be proxied through the background service worker.

Sub-projects 4a/4b (merged) established the message-passing pattern this design reuses: `chrome.runtime.sendMessage`/`onMessage`, dispatched through one listener in `service-worker.ts`, with browser-capability logic living in its own background module (mirroring `api-client.ts`'s separation from `service-worker.ts`'s dispatch).

## Confirmed decisions

- **Capture and crop both happen in the background service worker; only the small final cropped image crosses back to the content script.** `captureVisibleTab` captures the entire visible viewport at device-pixel resolution (potentially several MB as a PNG) — shipping that whole image through `chrome.runtime.sendMessage` to crop client-side would be wasteful. `OffscreenCanvas` and `createImageBitmap` are both available in an MV3 service worker (no `document`/`Image` needed), so the background can fetch the captured data URL into a `Blob`, decode it via `createImageBitmap`, draw the DPR-scaled crop region onto an `OffscreenCanvas`, and convert that to a `Blob` — all worker-side. Only that small `Blob` is sent back as the message response.
- **`devicePixelRatio` is read in the content script and sent explicitly in the request message** — it's a `window` property, unavailable to the background service worker, and is needed to convert the CSS-pixel selection `Rect` into the physical-pixel crop region against the device-pixel-resolution captured image.
- **A new, separate message contract** (`src/shared/capture-messages.ts`), distinct from `src/shared/api-messages.ts`. This never reaches `server/` — it's a local browser-capability round-trip, not a backend API call — so it doesn't belong in the `ApiMessage`/`ApiResponse` contract or flow through `api-client.ts`.
- **DRM/blackout detection uses a narrow "near-black" heuristic, not "any uniform color."** DRM-protected video renders as solid black in a screenshot (documented Chrome/EME behavior), not an arbitrary color. Sampling a 5×5 grid of points (same spirit as the existing DOM text-sampler) across the cropped pixel data and checking whether all sampled points are near-pure-black catches this specific failure mode while leaving legitimate solid-color image regions (banners, plain backgrounds) uncaptured by the heuristic. Known, accepted limitation: a genuinely solid-black image region would also trigger this and be treated as blocked — considered an acceptable tradeoff for this pass.
- **Pure math/detection logic is unit-tested; the real `captureVisibleTab`/`createImageBitmap`/`OffscreenCanvas` glue is manual-QA-only.** jsdom doesn't implement these real-browser image APIs — same constraint Step 3 already hit with `readFontAtPoint`, same established precedent (extract the pure, testable core; leave the browser-only glue thin and manually verified).
- **Two new dialogue states**, reusing existing CSS classes (`fontcia-btn`, `fontcia-result-actions`, `fontcia-no-match-message`, `fontcia-spinner`) — no new styling: "Analyzing image…" (shown immediately on triggering capture, and remains showing after a successful capture, since there's genuinely no matcher yet to hand the image to) and "Can't capture this content." (shown on DRM-block or any capture error, with a New scan escape hatch, no "Name it" button).
- **No manifest changes expected.** `activeTab` (already granted) should cover `captureVisibleTab` since the whole flow originates from the icon-click gesture on that tab — the same assumption `chrome.scripting.executeScript` already relies on elsewhere in this codebase. This needs explicit manual-QA verification, since permission edge cases are exactly the kind of thing that passes every unit test and only proves itself in real Chrome.
- **`LOG_SCAN` behavior is unchanged.** It already fires unconditionally for every no-match result today, before any reason-based branching (`logScanResult(result)` runs before the `if (result.status === 'match')` check in `handleScan`). Treating "no-text → image-capture-attempted" as a distinct backend-loggable outcome is a reasonable future refinement, not in scope here.

## Architecture

### File structure

```
src/shared/
  capture-messages.ts        — new: CaptureSelectionMessage request shape, CaptureResponse union
src/background/
  image-capture.ts           — new: pure math (cssRectToPixelRect, isSuspiciouslyBlack, grid-point sampling)
                                      + captureAndCropSelection() — the real browser-API glue
  service-worker.ts          — modified: dispatch CAPTURE_SELECTION messages to a new handleCaptureMessage,
                                          alongside the existing handleApiMessage dispatch
src/content/
  locked-selection.ts        — modified: branch on result.reason === 'no-text' in handleScan,
                                          new handleNoTextResult() function, capturedImageBlob closure state
  scan-dialogue.ts           — modified: renderAnalyzingImageState, renderCaptureBlockedState
tests/
  helpers/chrome-mock.ts     — modified: add tabs.captureVisibleTab mock
```

### Message contract (`src/shared/capture-messages.ts`)

```ts
import type { Rect } from './selection-box';

export interface CaptureSelectionMessage {
  type: 'CAPTURE_SELECTION';
  rect: Rect;
  devicePixelRatio: number;
}

export type CaptureResponse =
  | { status: 'captured'; blob: Blob }
  | { status: 'blocked' }
  | { status: 'error'; message: string };
```

`CaptureResponse` is a 3-way discriminated union rather than folding `blocked` into a generic error string — this keeps the DRM-block case type-safe and distinguishable from a technical failure (useful for future logging/debugging), even though both currently render the same UI state.

### `src/background/image-capture.ts`

**Pure, unit-tested functions:**

```ts
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cssRectToPixelRect(rect: Rect, devicePixelRatio: number): PixelRect {
  return {
    x: Math.round(rect.x * devicePixelRatio),
    y: Math.round(rect.y * devicePixelRatio),
    width: Math.round(rect.width * devicePixelRatio),
    height: Math.round(rect.height * devicePixelRatio),
  };
}

export interface SimpleImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function isSuspiciouslyBlack(image: SimpleImageData): boolean;
```

`isSuspiciouslyBlack` samples a 5×5 grid of points across `image` (25 points, inset from edges — same shape as `dom-sampling.ts`'s existing sample-grid approach) and returns `true` only if every sampled point's R, G, and B channels are all below a threshold of **12** (out of 255 — near-pure-black, not just "dark"). This exact value is a starting point, not empirically tuned against real DRM captures; the implementation plan should define it as a named constant (e.g. `BLACKNESS_THRESHOLD`) so it's easy to adjust later without hunting through the function body. Fully testable with synthetic `Uint8ClampedArray` inputs (an all-black array → `true`; any varied array, or an array with even one channel at 13+, → `false`).

**Browser-API glue (manual-QA-only, not unit tested):**

```ts
export type CaptureOutcome = CaptureResponse; // same 3-way shape

export async function captureAndCropSelection(
  windowId: number,
  rect: Rect,
  devicePixelRatio: number,
): Promise<CaptureOutcome>;
```

Sequence: `chrome.tabs.captureVisibleTab(windowId, { format: 'png' })` → `fetch(dataUrl)` → `.blob()` → `createImageBitmap(blob)` → compute `cssRectToPixelRect` → draw the cropped region onto a correctly-sized `OffscreenCanvas` → `ctx.getImageData(...)` → `isSuspiciouslyBlack(...)` check → if not blocked, `canvas.convertToBlob({ type: 'image/png' })` and return `{status:'captured', blob}`. Any thrown error (permission failure, a `null` 2D context, a degenerate zero-size crop, etc.) is caught and returned as `{status:'error', message}` rather than propagating — this function never rejects.

### `service-worker.ts` changes

The existing listener:

```ts
chrome.runtime.onMessage.addListener((message: ApiMessage, _sender, sendResponse) => {
  handleApiMessage(message).then(sendResponse);
  return true;
});
```

becomes (message type widened, one new branch added before the existing dispatch):

```ts
chrome.runtime.onMessage.addListener((message: ApiMessage | CaptureSelectionMessage, sender, sendResponse) => {
  if (message.type === 'CAPTURE_SELECTION') {
    handleCaptureMessage(message, sender).then(sendResponse);
  } else {
    handleApiMessage(message).then(sendResponse);
  }
  return true;
});

async function handleCaptureMessage(
  message: CaptureSelectionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureResponse> {
  const windowId = sender.tab?.windowId;
  if (windowId === undefined) {
    return { status: 'error', message: 'Unable to determine window for capture' };
  }
  return captureAndCropSelection(windowId, message.rect, message.devicePixelRatio);
}
```

`handleApiMessage`'s own signature and internal switch are untouched — this is a minimal, additive change to already-reviewed code.

### `locked-selection.ts` changes

`handleScan`'s result branch gains a `reason` check:

```ts
scanFn(rect)
  .then((result) => {
    logScanResult(result);
    if (disposed) return;
    if (result.status === 'match') {
      showResult(result);
    } else if (result.status === 'no-match' && result.reason === 'no-text') {
      handleNoTextResult();
    } else {
      renderNoMatchState(body, onRestart);
    }
  })
  ...
```

New closure state and function, following the same pattern as every other async flow already in this file (`disposed` guard, console error logging on failure):

```ts
let capturedImageBlob: Blob | null = null;

function handleNoTextResult(): void {
  renderAnalyzingImageState(body);
  const message: CaptureSelectionMessage = {
    type: 'CAPTURE_SELECTION',
    rect,
    devicePixelRatio: window.devicePixelRatio,
  };
  chrome.runtime.sendMessage(message)
    .then((response: CaptureResponse) => {
      if (disposed) return;
      if (response.status === 'captured') {
        capturedImageBlob = response.blob;
        console.log('fontCIA: captured image for analysis', response.blob);
        // Stays on "Analyzing image…" — no matcher exists yet; a future
        // sub-project replaces this branch with a real result render.
      } else if (response.status === 'blocked') {
        renderCaptureBlockedState(body, onRestart);
      } else {
        console.error('fontCIA: image capture failed', response.message);
        renderCaptureBlockedState(body, onRestart);
      }
    })
    .catch((error: unknown) => {
      if (disposed) return;
      console.error('fontCIA: image capture message failed', error);
      renderCaptureBlockedState(body, onRestart);
    });
}
```

### `scan-dialogue.ts` additions

```ts
export function renderAnalyzingImageState(body: HTMLElement): void;
export function renderCaptureBlockedState(body: HTMLElement, onNewScan: () => void): void;
```

`renderAnalyzingImageState` reuses the existing `.fontcia-spinner` element plus a text line ("Analyzing image…"). `renderCaptureBlockedState` mirrors `renderNoMatchState`'s shape (message + actions row) but with "Can't capture this content." text and only a New scan button (no disabled "Name it" button, since that's specific to the unrecognized-font case).

## Data flow (end to end)

1. `handleScan` calls `scanFn(rect)` (DOM resolution) as today.
2. Resolution returns `{status:'no-match', reason:'no-text'}`.
3. `handleNoTextResult()` renders "Analyzing image…" and sends `CAPTURE_SELECTION` with the rect and `window.devicePixelRatio`.
4. Background's `handleCaptureMessage` resolves the sender's `windowId` and calls `captureAndCropSelection`.
5. Background captures the full viewport, decodes it, crops to the DPR-scaled selection region, checks for near-black blockout, and returns `captured`/`blocked`/`error`.
6. Content script receives the response: `captured` → holds the `Blob` in memory, logs it, stays on the analyzing placeholder; `blocked` or `error` → renders "Can't capture this content."

## Error handling

Every failure mode (message-passing rejection, missing `windowId`, canvas/context errors, a degenerate zero-size crop, any thrown exception inside `captureAndCropSelection`) collapses to the same "Can't capture this content" UI — no need for more granular user-facing error text at this plumbing-only stage. Failures are still distinguished in the type system (`'blocked'` vs `'error'` with a message) and logged to console with detail, for future debugging, even though the UI treats them identically for now. The existing `disposed` guard pattern is applied to this new async flow exactly as it already is to every other async continuation in `locked-selection.ts`.

## Testing

- **Unit-tested**: `cssRectToPixelRect` and `isSuspiciouslyBlack` (synthetic `Uint8ClampedArray`/`Rect` inputs, no real image APIs needed). `handleCaptureMessage`'s dispatch logic in `service-worker.ts`, by mocking `image-capture.ts`'s `captureAndCropSelection` export — the same pattern already used to test `handleApiMessage` against mocked `api-client.ts` functions. `locked-selection.ts`'s new `handleNoTextResult` and the `handleScan` reason-branch, by mocking `chrome.runtime.sendMessage`'s resolved `CaptureResponse` and asserting the correct render function fires, matching every other async flow already tested in that file (including `disposed`-guard behavior).
- **Not unit-tested, manual-QA-only**: `captureAndCropSelection` itself — the real `chrome.tabs.captureVisibleTab`/`createImageBitmap`/`OffscreenCanvas` sequence. jsdom doesn't implement these real-browser image APIs, matching the exact constraint and precedent already established for `dom-sampling.ts`'s `readFontAtPoint` in Step 3.
- **Manual QA checklist** (to be executed once implemented): select an image region with no underlying DOM text and confirm "Analyzing image…" shows, then confirm a `Blob` is logged to the background service worker's devtools console; find or construct a DRM-protected video region (or a solid-black test region) and confirm "Can't capture this content." fires instead; confirm no permission-prompt/error occurs in real Chrome (verifying the `activeTab`-is-sufficient assumption).

## Out of scope for this spec

Actual image matching, any AI model, embeddings, or vector search — a distinct, later sub-project. Uploading the captured image anywhere — held in memory and console-logged only. Any change to `LOG_SCAN`'s backend-analytics semantics for the no-text case. Manifest changes (none expected; a follow-up would be needed only if manual QA disproves the `activeTab` assumption). Downscaling or normalizing the captured image's resolution for a future model's input requirements. A more granular DRM-vs-generic-error UI distinction — both currently render identically.
