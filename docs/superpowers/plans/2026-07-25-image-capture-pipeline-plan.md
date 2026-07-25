# Image Capture Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When DOM font-resolution finds no text under a locked selection, capture the visible tab, crop it (background-side, DPR-aware) to the selection rectangle, detect DRM/blackout via a near-black pixel heuristic, and hold the resulting image in memory behind a new "Analyzing image…" placeholder UI — no actual matching yet.

**Architecture:** A new message contract (`capture-messages.ts`) separate from the backend `ApiMessage` contract, since this never leaves the browser. Capture and crop both happen in the background service worker (`OffscreenCanvas`/`createImageBitmap`, both available without a DOM); only the small cropped `Blob` crosses back to the content script. `locked-selection.ts` gains one new branch on `NoMatchResult.reason === 'no-text'` and two new dialogue states.

**Tech Stack:** Vanilla TypeScript, `chrome.tabs.captureVisibleTab`, `OffscreenCanvas`, `createImageBitmap`, Vitest + jsdom.

---

## File Structure

```
src/
  shared/
    capture-messages.ts     — CaptureSelectionMessage request + CaptureResponse union (new)
  background/
    image-capture.ts        — pure DPR/blackness math (tested) + captureAndCropSelection glue (manual-QA-only) (new)
    service-worker.ts       — gains handleCaptureMessage + widened onMessage dispatch (modified)
  content/
    scan-dialogue.ts        — renderAnalyzingImageState, renderCaptureBlockedState (modified)
    locked-selection.ts     — branches on reason === 'no-text', new handleNoTextResult (modified)
tests/
  image-capture.test.ts     (new)
  service-worker.test.ts    (modified — extends existing file)
  scan-dialogue.test.ts     (modified — extends existing file)
  locked-selection.test.ts  (modified — extends existing file)
```

No manifest changes are planned — `activeTab` (already granted) is expected to cover `captureVisibleTab` since the whole flow originates from the icon-click gesture on that tab. Task 6's manual QA explicitly verifies this assumption. `tests/helpers/chrome-mock.ts` is deliberately **not** modified: no test in this plan calls `chrome.tabs.captureVisibleTab` directly — `captureAndCropSelection` (the one function that does) is real-browser-only and untested (see Task 2), and `handleCaptureMessage`'s tests mock the whole `image-capture.ts` module instead, the same way the existing `handleApiMessage` tests mock `api-client.ts` rather than the underlying `fetch`.

---

### Task 1: Shared Capture Message Types

**Files:**
- Create: `src/shared/capture-messages.ts`

No dedicated test file for this task — pure type declarations with no logic, the same category as the existing untested `src/shared/api-messages.ts` and `src/content/scan-types.ts`.

- [ ] **Step 1: Create `src/shared/capture-messages.ts`**

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

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/capture-messages.ts
git commit -m "feat: add capture message contract for the image capture pipeline"
```

---

### Task 2: Crop Math, Blackness Detection, and Capture Glue

**Files:**
- Create: `src/background/image-capture.ts`
- Test: `tests/image-capture.test.ts`

This task has two parts: pure functions (TDD, unit-tested) and one browser-API-bound function (written directly, not unit-tested, with a comment explaining why — matching the exact precedent `src/content/dom-sampling.ts`'s `readFontAtPoint` already set in Step 3, since jsdom implements neither `OffscreenCanvas` nor `createImageBitmap`).

- [ ] **Step 1: Write the failing tests for the pure functions**

`tests/image-capture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cssRectToPixelRect, isSuspiciouslyBlack, BLACKNESS_THRESHOLD } from '../src/background/image-capture';

describe('cssRectToPixelRect', () => {
  it('scales a CSS rect by the device pixel ratio', () => {
    const result = cssRectToPixelRect({ x: 10, y: 20, width: 100, height: 50 }, 2);
    expect(result).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });

  it('rounds fractional results to whole pixels', () => {
    const result = cssRectToPixelRect({ x: 10.4, y: 20.6, width: 100.5, height: 50.5 }, 1.5);
    expect(result).toEqual({ x: 16, y: 31, width: 151, height: 76 });
  });

  it('handles a devicePixelRatio of 1 as a no-op scale', () => {
    const result = cssRectToPixelRect({ x: 5, y: 5, width: 40, height: 30 }, 1);
    expect(result).toEqual({ x: 5, y: 5, width: 40, height: 30 });
  });
});

describe('isSuspiciouslyBlack', () => {
  function makeUniformImage(
    width: number,
    height: number,
    r: number,
    g: number,
    b: number,
  ): { data: Uint8ClampedArray; width: number; height: number } {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    return { data, width, height };
  }

  it('returns true for a fully black image', () => {
    expect(isSuspiciouslyBlack(makeUniformImage(20, 20, 0, 0, 0))).toBe(true);
  });

  it('returns true for an image at exactly the blackness threshold', () => {
    expect(
      isSuspiciouslyBlack(makeUniformImage(20, 20, BLACKNESS_THRESHOLD, BLACKNESS_THRESHOLD, BLACKNESS_THRESHOLD)),
    ).toBe(true);
  });

  it('returns false for an image one shade above the threshold', () => {
    expect(isSuspiciouslyBlack(makeUniformImage(20, 20, BLACKNESS_THRESHOLD + 1, 0, 0))).toBe(false);
  });

  it('returns false for a uniform non-black color', () => {
    expect(isSuspiciouslyBlack(makeUniformImage(20, 20, 200, 100, 50))).toBe(false);
  });

  it('returns false for an image with visible content (not uniform)', () => {
    const image = makeUniformImage(20, 20, 0, 0, 0);
    // (10, 10) is one of the 5x5 grid's sampled points for a 20x20 image
    // (col=2, row=2 maps to fx=fy=0.5 -> floor(0.5*20)=10) — punching a
    // bright pixel there proves the sampler actually notices it.
    const idx = (10 * 20 + 10) * 4;
    image.data[idx] = 255;
    image.data[idx + 1] = 255;
    image.data[idx + 2] = 255;
    expect(isSuspiciouslyBlack(image)).toBe(false);
  });

  it('returns false for a zero-size image', () => {
    expect(isSuspiciouslyBlack({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/image-capture.test.ts`
Expected: FAIL — `Cannot find module '../src/background/image-capture'`

- [ ] **Step 3: Write `src/background/image-capture.ts`**

```ts
import type { Rect } from '../shared/selection-box';
import type { CaptureResponse } from '../shared/capture-messages';

export const BLACKNESS_THRESHOLD = 12;
export const BLACKNESS_SAMPLE_GRID = 5;

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

// Mirrors dom-sampling.ts's generateSamplePoints (0.1-0.9 inset, same
// gridSize-1 denominator) for a raster pixel grid instead of a CSS rect.
function generatePixelGridPoints(
  width: number,
  height: number,
  gridSize: number,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let col = 0; col < gridSize; col++) {
    for (let row = 0; row < gridSize; row++) {
      const fx = 0.1 + (0.8 * col) / (gridSize - 1);
      const fy = 0.1 + (0.8 * row) / (gridSize - 1);
      points.push({
        x: Math.min(width - 1, Math.floor(fx * width)),
        y: Math.min(height - 1, Math.floor(fy * height)),
      });
    }
  }
  return points;
}

// DRM-protected video renders as solid black in a captureVisibleTab
// screenshot (a documented Chrome/EME behavior) — not an arbitrary color.
// Checking specifically for near-black, rather than "any uniform color",
// avoids flagging a legitimately capturable solid-color image region (a
// plain banner, an empty margin) as blocked. Known, accepted limitation: a
// genuinely solid-black image region would also trigger this.
export function isSuspiciouslyBlack(image: SimpleImageData): boolean {
  if (image.width <= 0 || image.height <= 0) return false;

  const points = generatePixelGridPoints(image.width, image.height, BLACKNESS_SAMPLE_GRID);
  for (const { x, y } of points) {
    const idx = (y * image.width + x) * 4;
    const r = image.data[idx];
    const g = image.data[idx + 1];
    const b = image.data[idx + 2];
    if (r > BLACKNESS_THRESHOLD || g > BLACKNESS_THRESHOLD || b > BLACKNESS_THRESHOLD) {
      return false;
    }
  }
  return true;
}

// The one function in this file that touches real browser capture/canvas
// APIs (chrome.tabs.captureVisibleTab, createImageBitmap, OffscreenCanvas).
// jsdom implements none of these — no layout engine, no image decoding — so
// this cannot be meaningfully unit-tested. Verified only by the manual
// Chrome checklist (Task 6), the same treatment Step 3 gave
// dom-sampling.ts's readFontAtPoint.
export async function captureAndCropSelection(
  windowId: number,
  rect: Rect,
  devicePixelRatio: number,
): Promise<CaptureResponse> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const captureRes = await fetch(dataUrl);
    const captureBlob = await captureRes.blob();
    const bitmap = await createImageBitmap(captureBlob);

    const pixelRect = cssRectToPixelRect(rect, devicePixelRatio);
    if (pixelRect.width <= 0 || pixelRect.height <= 0) {
      return { status: 'error', message: 'Selection is too small to capture' };
    }

    const canvas = new OffscreenCanvas(pixelRect.width, pixelRect.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { status: 'error', message: 'Canvas context unavailable' };
    }

    ctx.drawImage(
      bitmap,
      pixelRect.x,
      pixelRect.y,
      pixelRect.width,
      pixelRect.height,
      0,
      0,
      pixelRect.width,
      pixelRect.height,
    );

    const imageData = ctx.getImageData(0, 0, pixelRect.width, pixelRect.height);
    if (isSuspiciouslyBlack(imageData)) {
      return { status: 'blocked' };
    }

    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    return { status: 'captured', blob: croppedBlob };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Unknown capture error' };
  }
}
```

`ctx.getImageData(...)` returns a real `ImageData`, which is structurally compatible with `SimpleImageData` (`.data`/`.width`/`.height`) — that's deliberate: `isSuspiciouslyBlack` is declared against the narrower `SimpleImageData` interface specifically so its tests can pass plain synthetic objects without needing a real `ImageData` instance, while still being directly usable with the real thing at runtime.

- [ ] **Step 4: Run tests to verify the pure-function tests pass**

Run: `npx vitest run tests/image-capture.test.ts`
Expected: PASS — `cssRectToPixelRect` (3) + `isSuspiciouslyBlack` (6) = **9 tests passed**. (`captureAndCropSelection` has no tests in this file — that's expected, per the comment above it.)

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/background/image-capture.ts tests/image-capture.test.ts
git commit -m "feat: add DPR crop math, blackness detection, and capture-and-crop glue"
```

---

### Task 3: Background Message Dispatch for CAPTURE_SELECTION

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts` (extends existing file)

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `tests/service-worker.test.ts`, immediately after the existing `describe('handleApiMessage', ...)` block and before `describe('module load side effects', ...)`:

```ts
describe('handleCaptureMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves windowId from the sender and delegates to captureAndCropSelection', async () => {
    vi.doMock('../src/background/image-capture', () => ({
      captureAndCropSelection: vi.fn(async () => ({ status: 'captured', blob: new Blob() })),
    }));
    const { handleCaptureMessage } = await import('../src/background/service-worker');
    const { captureAndCropSelection } = await import('../src/background/image-capture');

    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const sender = { tab: { windowId: 42 } } as chrome.runtime.MessageSender;

    const result = await handleCaptureMessage({ type: 'CAPTURE_SELECTION', rect, devicePixelRatio: 2 }, sender);

    expect(captureAndCropSelection).toHaveBeenCalledWith(42, rect, 2);
    expect(result).toEqual({ status: 'captured', blob: expect.any(Blob) });
  });

  it('returns an error response without calling captureAndCropSelection when the sender has no windowId', async () => {
    vi.doMock('../src/background/image-capture', () => ({
      captureAndCropSelection: vi.fn(),
    }));
    const { handleCaptureMessage } = await import('../src/background/service-worker');
    const { captureAndCropSelection } = await import('../src/background/image-capture');

    const result = await handleCaptureMessage(
      { type: 'CAPTURE_SELECTION', rect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1 },
      {} as chrome.runtime.MessageSender,
    );

    expect(captureAndCropSelection).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'error', message: 'Unable to determine window for capture' });
  });
});
```

This follows the exact same `vi.resetModules()`/`vi.doMock()`/dynamic-`import()` pattern already used for `handleApiMessage`'s tests immediately above it in this file — including inheriting the suite-wide `testTimeout`/`hookTimeout: 20000` already set in `vitest.config.ts` for this exact class of test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — `handleCaptureMessage` is not exported from `../src/background/service-worker`.

- [ ] **Step 3: Modify `src/background/service-worker.ts`**

Change the top imports from:

```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan } from './api-client';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
```

to:

```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan } from './api-client';
import { captureAndCropSelection } from './image-capture';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
```

Change the final block from:

```ts
chrome.runtime.onMessage.addListener((message: ApiMessage, _sender, sendResponse) => {
  handleApiMessage(message).then(sendResponse);
  return true;
});
```

to:

```ts
export async function handleCaptureMessage(
  message: CaptureSelectionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureResponse> {
  const windowId = sender.tab?.windowId;
  if (windowId === undefined) {
    return { status: 'error', message: 'Unable to determine window for capture' };
  }
  return captureAndCropSelection(windowId, message.rect, message.devicePixelRatio);
}

chrome.runtime.onMessage.addListener(
  (message: ApiMessage | CaptureSelectionMessage, sender: chrome.runtime.MessageSender, sendResponse) => {
    if (message.type === 'CAPTURE_SELECTION') {
      handleCaptureMessage(message, sender).then(sendResponse);
    } else {
      handleApiMessage(message).then(sendResponse);
    }
    return true;
  },
);
```

`handleApiMessage`'s own definition (the `switch` and its try/catch) is completely unchanged — this is a minimal, additive change to already-tested code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — the file's existing 23 tests (7 `handleIconClick` + 6 `isInjectableUrl` + 9 `handleApiMessage` + 1 `module load side effects`) plus the new 2 `handleCaptureMessage` tests = **25 tests passed**.

- [ ] **Step 5: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run --exclude "**/server/**"`
Expected: clean typecheck; all extension tests pass (excludes `server/tests/*`, which needs a local Postgres instance not relevant to this sub-project).

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: dispatch CAPTURE_SELECTION messages to the image capture module"
```

---

### Task 4: New Dialogue States

**Files:**
- Modify: `src/content/scan-dialogue.ts`
- Test: `tests/scan-dialogue.test.ts` (extends existing file)

- [ ] **Step 1: Write the failing tests**

Add these two new `describe` blocks to `tests/scan-dialogue.test.ts`, after the existing `describe('renderNoMatchState', ...)` block:

```ts
describe('renderAnalyzingImageState', () => {
  it('renders a spinner and an analyzing message with no interactive elements', () => {
    const body = document.createElement('div');

    renderAnalyzingImageState(body);

    expect(body.querySelector('.fontcia-spinner')).not.toBeNull();
    expect(body.querySelector('.fontcia-analyzing-message')?.textContent).toBe('Analyzing image…');
    expect(body.querySelector('button')).toBeNull();
  });

  it('clears any previous content before rendering', () => {
    const body = document.createElement('div');
    body.textContent = 'stale content';

    renderAnalyzingImageState(body);

    expect(body.textContent).not.toContain('stale content');
  });
});

describe('renderCaptureBlockedState', () => {
  it('renders a message and a New scan button, with no Name-it button', () => {
    const body = document.createElement('div');

    renderCaptureBlockedState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'Name it')).toBe(false);
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderCaptureBlockedState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
```

Also update this file's top import line from:

```ts
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from '../src/content/scan-dialogue';
```

to:

```ts
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
} from '../src/content/scan-dialogue';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: FAIL — `renderAnalyzingImageState`/`renderCaptureBlockedState` are not exported from `../src/content/scan-dialogue`.

- [ ] **Step 3: Modify `src/content/scan-dialogue.ts`**

Add these two new exported functions at the end of the file (after the existing `renderNoMatchState`):

```ts
export function renderAnalyzingImageState(body: HTMLElement): void {
  body.replaceChildren();

  const spinner = document.createElement('div');
  spinner.className = 'fontcia-spinner';
  body.appendChild(spinner);

  const message = document.createElement('div');
  message.className = 'fontcia-analyzing-message';
  message.textContent = 'Analyzing image…';
  body.appendChild(message);
}

export function renderCaptureBlockedState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "Can't capture this content.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

`renderCaptureBlockedState` deliberately reuses the `.fontcia-no-match-message`/`.fontcia-result-actions`/`.fontcia-btn-secondary` classes `renderNoMatchState` already uses — no new CSS, matching the "reuse existing styling" decision from the spec. It omits the disabled "Name it" button, since that's specific to the unrecognized-font case.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — `renderReadyState` (2) + `renderLoadingState` (1) + `renderResultState` (6) + `renderNoMatchState` (2) + `renderAnalyzingImageState` (2) + `renderCaptureBlockedState` (2) = **15 tests passed**.

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content/scan-dialogue.ts tests/scan-dialogue.test.ts
git commit -m "feat: add Analyzing-image and capture-blocked dialogue states"
```

---

### Task 5: Wire the No-Text Branch to the Capture Pipeline

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts` (extends existing file)

- [ ] **Step 1: Write the failing tests**

Add this new import to the top of `tests/locked-selection.test.ts`:

```ts
import type { CaptureResponse } from '../src/shared/capture-messages';
```

(the file's other imports — `describe, it, expect, vi, beforeEach` from vitest, `createChromeMock`, `renderLockedSelection`, `ScanResult` — are unchanged)

Add these 7 new tests to the end of the `describe('renderLockedSelection', ...)` block, right before its closing `});`:

```ts
  it('shows "Analyzing image…" and sends CAPTURE_SELECTION when the scan result is no-text', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const captureDeferred = createDeferred<CaptureResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return captureDeferred.promise;
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-analyzing-message')?.textContent).toBe('Analyzing image…');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 10, y: 20, width: 200, height: 30 },
      devicePixelRatio: window.devicePixelRatio,
    });
  });

  it('scales the CAPTURE_SELECTION message by the real window.devicePixelRatio', async () => {
    const originalDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const captureDeferred = createDeferred<CaptureResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return captureDeferred.promise;
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 10, y: 20, width: 200, height: 30 },
      devicePixelRatio: 2,
    });

    Object.defineProperty(window, 'devicePixelRatio', { value: originalDpr, configurable: true });
  });

  it('holds the captured Blob and logs it, staying on the analyzing state, on a successful capture', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-analyzing-message')?.textContent).toBe('Analyzing image…');
    expect(consoleLogSpy).toHaveBeenCalledWith('fontCIA: captured image for analysis', fakeBlob);

    consoleLogSpy.mockRestore();
  });

  it('renders the capture-blocked state when the response is blocked', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'blocked' };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
  });

  it('renders the capture-blocked state and logs an error when the response is an error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'error', message: 'capture failed' };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
    expect(consoleErrorSpy).toHaveBeenCalledWith('fontCIA: image capture failed', 'capture failed');

    consoleErrorSpy.mockRestore();
  });

  it('renders the capture-blocked state when the CAPTURE_SELECTION message itself rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') throw new Error('service worker unreachable');
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
    expect(consoleErrorSpy).toHaveBeenCalledWith('fontCIA: image capture message failed', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('does not render anything after dispose() while the capture response is still pending', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const captureDeferred = createDeferred<CaptureResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return captureDeferred.promise;
      return { ok: true, data: null };
    });

    const { panel, dispose } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();

    dispose();
    captureDeferred.resolve({ status: 'blocked' });
    await captureDeferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')).toBeNull();
    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — `.fontcia-analyzing-message` never appears (the current code always calls `renderNoMatchState` for any no-match result, regardless of `reason`), and `chrome.runtime.sendMessage` is never called with a `CAPTURE_SELECTION` message.

- [ ] **Step 3: Modify `src/content/locked-selection.ts`**

Change the top imports from:

```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import { resolveFontFromSelection } from './font-resolver';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from './scan-dialogue';
```

to:

```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import { resolveFontFromSelection } from './font-resolver';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
} from './scan-dialogue';
```

Add a new closure variable alongside the existing `savedFontId`/`currentResult`/`togglePending` declarations:

```ts
  let capturedImageBlob: Blob | null = null;
```

Add a new function, anywhere above `handleScan` (e.g. directly after the `handleToggleSave` function):

```ts
  function handleNoTextResult(): void {
    renderAnalyzingImageState(body);
    const message: CaptureSelectionMessage = {
      type: 'CAPTURE_SELECTION',
      rect,
      devicePixelRatio: window.devicePixelRatio,
    };
    chrome.runtime
      .sendMessage(message)
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

Change `handleScan`'s result branch from:

```ts
  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        // An in-flight scan must not touch the DOM after the panel is dismissed
        // (Esc, the close button, or an icon-click toggle-off) — all three
        // converge on overlay.ts's teardownOverlay(), which calls dispose()
        // before this promise can resolve into a stale render.
        if (disposed) return;
        if (result.status === 'match') {
          showResult(result);
        } else {
          renderNoMatchState(body, onRestart);
        }
      })
      .catch((error: unknown) => {
        logScanResult({ status: 'no-match', reason: 'error' });
        if (disposed) return;
        console.error('fontCIA: font resolution failed', error);
        renderNoMatchState(body, onRestart);
      });
  }
```

to:

```ts
  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        // An in-flight scan must not touch the DOM after the panel is dismissed
        // (Esc, the close button, or an icon-click toggle-off) — all three
        // converge on overlay.ts's teardownOverlay(), which calls dispose()
        // before this promise can resolve into a stale render.
        if (disposed) return;
        if (result.status === 'match') {
          showResult(result);
        } else if (result.status === 'no-match' && result.reason === 'no-text') {
          handleNoTextResult();
        } else {
          renderNoMatchState(body, onRestart);
        }
      })
      .catch((error: unknown) => {
        logScanResult({ status: 'no-match', reason: 'error' });
        if (disposed) return;
        console.error('fontCIA: font resolution failed', error);
        renderNoMatchState(body, onRestart);
      });
  }
```

`capturedImageBlob` is intentionally write-only in this sub-project (assigned, never read elsewhere) — it exists so the captured image survives in memory for a future matching sub-project to consume, per the spec's explicit scope. `chrome.runtime.sendMessage` is called directly here (not through a `sendCaptureMessage<T>` wrapper like `sendApiMessage`) since there's only this one call site for capture messages in the whole file, unlike `ApiMessage`, which has many — extracting a one-call-site wrapper would be premature.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — **29 tests passed** (22 existing + 7 new).

- [ ] **Step 5: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run --exclude "**/server/**"`
Expected: clean typecheck; all extension tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: capture and hold an image when DOM resolution finds no text"
```

---

### Task 6: Final Verification

**Files:** None (verification only).

- [ ] **Step 1: Full suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run --exclude "**/server/**"`
Expected: clean typecheck; full extension suite passes. Expected total test count: `image-capture.test.ts` (9) + the running totals from Tasks 3-5 folded into the existing files — run the suite and confirm the reported total matches `9 (image-capture) + 25 (service-worker) + 15 (scan-dialogue) + 29 (locked-selection) +` every other pre-existing, untouched test file's count. Run it **at least 3 times** to check for flakiness, consistent with this codebase's established practice around the `vi.resetModules()`-based tests touched in Task 3.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: exit 0, no changes needed to `esbuild.config.mjs` (no new entry points — `image-capture.ts` and `capture-messages.ts` are both pulled in by the existing `background/service-worker.ts` and `content/overlay.ts` bundles respectively, via their existing import graphs).

- [ ] **Step 3: Manual QA in Chrome**

Prerequisite: load the unpacked extension (`dist/`) in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

1. Find a webpage with an image, video thumbnail, or `<canvas>` element containing no underlying DOM text (e.g. a photo, a logo image, a video poster frame). Select it with the crosshair tool and click Scan.
2. Confirm the panel shows "Analyzing image…" (not the generic "We don't recognize this one." message).
3. Open the extension's background service worker DevTools console (`chrome://extensions` → fontCIA → "service worker" → Inspect) and confirm no errors appear during the capture.
4. Back in the page's own console (or by adding a temporary breakpoint), confirm a `Blob` was logged via `fontCIA: captured image for analysis` — check its `size`/`type` look reasonable (a real, non-trivial PNG, `type: 'image/png'`).
5. Confirm no `activeTab`/permission error appears anywhere — this verifies the spec's assumption that no manifest change is needed. If a permission error DOES appear, this is a real finding: report it, don't silently work around it, since it would mean the spec's `host_permissions`/`activeTab` assumption was wrong and needs a follow-up fix.
6. If you can find or construct a DRM-protected video (e.g. a streaming service using Widevine) or a page with a genuinely solid-black image region, select it and confirm "Can't capture this content." appears instead of "Analyzing image…".
7. Confirm ordinary DOM-text font detection (an existing, unrelated flow) still works normally on a page with real text — this change should have zero effect on the `result.status === 'match'` and non-`no-text` no-match paths.
8. Confirm `New scan` from the "Can't capture this content." state correctly re-arms the crosshair, matching every other terminal state's existing behavior.

- [ ] **Step 4: Record results**

If all checks pass, this sub-project is complete. If a fix is required, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix.

---

## Self-Review Notes

- **Spec coverage:** background-owned capture+crop with only the final Blob crossing back (Task 2's `captureAndCropSelection`, Task 3's dispatch) → covered; `devicePixelRatio` read in the content script and sent explicitly (Task 5's `handleNoTextResult`) → covered; separate `capture-messages.ts` contract, not mixed into `api-messages.ts` (Task 1) → covered; near-black DRM heuristic with a named, adjustable threshold constant (Task 2's `isSuspiciouslyBlack`/`BLACKNESS_THRESHOLD`) → covered; pure-function/manual-QA testing split (Task 2's explicit comment + Task 6's manual checklist) → covered; the two new UI states reusing existing CSS classes (Task 4) → covered; no manifest changes, with explicit manual verification of that assumption (Task 6, Step 3.5) → covered; `LOG_SCAN` behavior left unchanged (no task touches `logScanResult`) → covered; no upload/matching/model logic anywhere in this plan → covered, matches "out of scope."
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `CaptureSelectionMessage`/`CaptureResponse` (Task 1) are used identically across `image-capture.ts`'s `captureAndCropSelection` return type (Task 2), `service-worker.ts`'s `handleCaptureMessage` parameter/return types (Task 3), and `locked-selection.ts`'s `handleNoTextResult` message construction and response handling (Task 5) — same shapes everywhere, no drift. `cssRectToPixelRect`'s `PixelRect` return shape (Task 2) is consumed consistently within `captureAndCropSelection`'s own body (same task, same file). `BLACKNESS_THRESHOLD` is imported into the test file from the same module it's defined in (Task 2), not redefined/duplicated. `renderAnalyzingImageState`/`renderCaptureBlockedState` (Task 4) are imported and called with matching signatures in `locked-selection.ts` (Task 5) — confirmed both were designed together, no stale call site.
- **Deliberate deviation from the spec's literal file list:** the spec listed `tests/helpers/chrome-mock.ts` as a file to modify (add a `tabs.captureVisibleTab` mock). Working through the concrete test design in Task 3, this turned out to be unnecessary: `captureAndCropSelection` — the only function that calls `chrome.tabs.captureVisibleTab` — is deliberately untested (Task 2), and `handleCaptureMessage`'s tests mock the whole `image-capture.ts` module instead (matching the existing `handleApiMessage`-mocks-`api-client.ts` pattern), so no test in this plan ever reaches a real or mocked `chrome.tabs.captureVisibleTab` call. Adding an unused mock method would be dead code in a shared test helper. This plan does not modify `tests/helpers/chrome-mock.ts`.
