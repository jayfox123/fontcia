# Image Match Client Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the capture pipeline's cropped image `Blob` to the real `POST /font-matches` endpoint and replace the "Analyzing image…" placeholder with a real, honestly-uncertain ranked-candidates UI.

**Architecture:** A new `MATCH_IMAGE` message (parallel to the existing `CAPTURE_SELECTION` contract, since it carries a `Blob` outside the JSON-only `ApiMessage` transport) carries the Blob from content script to background script, where a new `matchImage()` function does its own multipart `fetch` to `/font-matches`. Three new UI states in `scan-dialogue.ts` (ranked matches, no-confident-match, match-error) replace the frozen placeholder, each independently saveable per candidate via the existing unchanged `SAVE_FONT` message.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3, Vitest + jsdom (existing extension conventions — no new dependencies).

---

## File Structure

```
src/shared/
  match-messages.ts          — new: MatchImageMessage, MatchImageResponse, RankedMatch

src/content/
  scan-types.ts               — modified: adds ImageMatchResult
  scan-dialogue.ts            — modified: adds renderRankedMatchesState, renderNoConfidentMatchState, renderMatchErrorState
  locked-selection.ts         — modified: consumes the Blob instead of discarding it
  theme.ts                    — modified: adds .fontcia-match-list/-item/-name/-confidence CSS

src/background/
  api-client.ts                — modified: adds matchImage()
  service-worker.ts            — modified: adds handleMatchImageMessage + a third onMessage branch

tests/
  api-client.test.ts            — modified: adds matchImage tests
  service-worker.test.ts        — modified: adds handleMatchImageMessage tests
  scan-dialogue.test.ts         — modified: adds tests for the three new render functions
  locked-selection.test.ts      — modified: replaces the stale "holds the Blob" test, adds new MATCH_IMAGE-flow tests
```

No new test files — each modified source file's existing test file gains new `describe` blocks, matching this project's established one-test-file-per-source-file convention.

---

### Task 1: Shared Types

**Files:**
- Create: `src/shared/match-messages.ts`
- Modify: `src/content/scan-types.ts`

No tests in this task — these are pure type declarations with no runtime behavior (TypeScript types are erased at compile time). Verified by `tsc --noEmit` in Step 3, matching how this project treats every other types-only file.

- [ ] **Step 1: Create `src/shared/match-messages.ts`**

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

- [ ] **Step 2: Add `ImageMatchResult` to `src/content/scan-types.ts`**

Change `src/content/scan-types.ts` from:
```ts
export interface ScanSource {
  url: string;
  label: string;
  votes: number;
}

export interface MatchResult {
  status: 'match';
  fontName: string;
  confidence: number;
  sources: ScanSource[];
}

export interface NoMatchResult {
  status: 'no-match';
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
}

export type ScanResult = MatchResult | NoMatchResult;
```
to:
```ts
import type { RankedMatch } from '../shared/match-messages';

export interface ScanSource {
  url: string;
  label: string;
  votes: number;
}

export interface MatchResult {
  status: 'match';
  fontName: string;
  confidence: number;
  sources: ScanSource[];
}

export interface NoMatchResult {
  status: 'no-match';
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
}

export type ScanResult = MatchResult | NoMatchResult;

export type ImageMatchResult =
  | { status: 'matches'; candidates: RankedMatch[] }
  | { status: 'no-confident-match' }
  | { status: 'error' };
```

**Note the circular-looking import**: `scan-types.ts` imports `RankedMatch` from `match-messages.ts`, which itself imports `ScanSource` from `scan-types.ts`. This is not a runtime circular dependency — both are `import type` (type-only imports, fully erased by `tsc`, never present in the compiled/bundled output), so there's no actual module-loading cycle, only a type-level reference in each direction. TypeScript handles this without issue.

- [ ] **Step 3: Run typecheck to verify both files compile cleanly**

Run: `npm run typecheck`
Expected: no errors (exit code 0, no output).

- [ ] **Step 4: Commit**

```bash
git add src/shared/match-messages.ts src/content/scan-types.ts
git commit -m "feat: add MatchImageMessage/RankedMatch/ImageMatchResult types"
```

---

### Task 2: `matchImage()` in `api-client.ts`

**Files:**
- Modify: `src/background/api-client.ts`
- Test: `tests/api-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api-client.test.ts`, after the existing `describe('logScan', ...)` block (the last one in the file):

```ts
describe('matchImage', () => {
  it('posts the blob as multipart form data and returns the matches array', async () => {
    const matches = [{ fontName: 'Inter', confidence: 82, sources: [] }];
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { matches }));

    const blob = new Blob(['fake image data'], { type: 'image/png' });
    const result = await matchImage(blob);

    expect(result).toEqual({ ok: true, data: matches });
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/font-matches');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.body).toBeInstanceOf(FormData);
    expect(requestInit.headers).toBeUndefined();
  });

  it('returns the server error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'image is required' }));

    const result = await matchImage(new Blob());

    expect(result).toEqual({ ok: false, error: 'image is required' });
  });

  it('falls back to a generic error when the error response has no JSON body', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(500));

    const result = await matchImage(new Blob());

    expect(result).toEqual({ ok: false, error: 'Request failed with status 500' });
  });
});
```

Also change the import block at the top of `tests/api-client.test.ts` from:
```ts
import {
  apiFetch,
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
} from '../src/background/api-client';
```
to:
```ts
import {
  apiFetch,
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
} from '../src/background/api-client';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api-client.test.ts`
Expected: FAIL — `matchImage` is not exported by `../src/background/api-client` (TypeScript/import error, or `matchImage is not a function` at runtime).

- [ ] **Step 3: Add `matchImage()` to `src/background/api-client.ts`**

Change the import block at the top of `src/background/api-client.ts` from:
```ts
import { API_BASE_URL } from '../shared/api-config';
import { getStoredAuth, setStoredAuth, clearStoredAuth } from './auth-storage';
import type { ApiResponse } from '../shared/api-messages';
import type { ScanSource } from '../content/scan-types';
```
to:
```ts
import { API_BASE_URL } from '../shared/api-config';
import { getStoredAuth, setStoredAuth, clearStoredAuth } from './auth-storage';
import type { ApiResponse } from '../shared/api-messages';
import type { ScanSource } from '../content/scan-types';
import type { RankedMatch } from '../shared/match-messages';
```

Add this function at the end of the file, after the existing `logScan`:

```ts
export async function matchImage(blob: Blob): Promise<ApiResponse<RankedMatch[]>> {
  const formData = new FormData();
  formData.append('image', blob, 'crop.png');

  // Bypasses apiFetch/rawRequest — those hardcode JSON.stringify + a
  // Content-Type: application/json header, incompatible with the
  // multipart/form-data body multer expects on this one endpoint.
  const res = await fetch(`${API_BASE_URL}/font-matches`, { method: 'POST', body: formData });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (res.status >= 200 && res.status < 300) {
    const data = json as { matches: RankedMatch[] };
    return { ok: true, data: data.matches };
  }

  const errorMessage = (json as { error?: string } | null)?.error ?? `Request failed with status ${res.status}`;
  return { ok: false, error: errorMessage };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api-client.test.ts`
Expected: PASS — all tests in the file pass, including the 3 new ones.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/api-client.ts tests/api-client.test.ts
git commit -m "feat: add matchImage() to POST /font-matches with a multipart body"
```

---

### Task 3: `service-worker.ts` Wiring

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/service-worker.test.ts`, after the existing `describe('handleCaptureMessage', ...)` block and before `describe('module load side effects', ...)`:

```ts
describe('handleMatchImageMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls matchImage with the blob and maps a successful ApiResponse to an ok MatchImageResponse', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(async () => ({ ok: true, data: [{ fontName: 'Inter', confidence: 82, sources: [] }] })),
    }));
    const { handleMatchImageMessage } = await import('../src/background/service-worker');
    const { matchImage } = await import('../src/background/api-client');

    const blob = new Blob(['fake image data']);
    const result = await handleMatchImageMessage({ type: 'MATCH_IMAGE', blob });

    expect(matchImage).toHaveBeenCalledWith(blob);
    expect(result).toEqual({ status: 'ok', matches: [{ fontName: 'Inter', confidence: 82, sources: [] }] });
  });

  it('maps a failed ApiResponse to an error MatchImageResponse', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(async () => ({ ok: false, error: 'embedding service unreachable' })),
    }));
    const { handleMatchImageMessage } = await import('../src/background/service-worker');

    const result = await handleMatchImageMessage({ type: 'MATCH_IMAGE', blob: new Blob() });

    expect(result).toEqual({ status: 'error', message: 'embedding service unreachable' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — `handleMatchImageMessage` is not exported by `../src/background/service-worker`.

- [ ] **Step 3: Wire `handleMatchImageMessage` into `src/background/service-worker.ts`**

Change the import block at the top from:
```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan } from './api-client';
import { captureAndCropSelection } from './image-capture';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
```
to:
```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan, matchImage } from './api-client';
import { captureAndCropSelection } from './image-capture';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse } from '../shared/match-messages';
```

Add `handleMatchImageMessage`, right after the existing `handleCaptureMessage` function:

```ts
export async function handleMatchImageMessage(message: MatchImageMessage): Promise<MatchImageResponse> {
  const result = await matchImage(message.blob);
  if (result.ok) {
    return { status: 'ok', matches: result.data };
  }
  return { status: 'error', message: result.error };
}
```

Change the `chrome.runtime.onMessage.addListener` call at the bottom of the file from:
```ts
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
to:
```ts
chrome.runtime.onMessage.addListener(
  (
    message: ApiMessage | CaptureSelectionMessage | MatchImageMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse,
  ) => {
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — all tests in the file pass, including the 2 new ones.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: dispatch MATCH_IMAGE to matchImage() in the background service worker"
```

---

### Task 4: New UI States in `scan-dialogue.ts`

**Files:**
- Modify: `src/content/scan-dialogue.ts`, `src/content/theme.ts`
- Test: `tests/scan-dialogue.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/scan-dialogue.test.ts`, after the existing `describe('renderCaptureBlockedState', ...)` block (the last one in the file):

```ts
describe('renderRankedMatchesState', () => {
  const candidates: RankedMatch[] = [
    {
      fontName: 'Inter',
      confidence: 82,
      sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
    },
    {
      fontName: 'Roboto',
      confidence: 61,
      sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
    },
  ];

  it('renders one item per candidate with its name, confidence, and sources', () => {
    const body = document.createElement('div');

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), true, vi.fn());

    const items = body.querySelectorAll('.fontcia-match-item');
    expect(items).toHaveLength(2);

    const names = Array.from(body.querySelectorAll('.fontcia-match-name')).map((el) => el.textContent);
    expect(names).toEqual(['Inter', 'Roboto']);

    const confidences = Array.from(body.querySelectorAll('.fontcia-match-confidence')).map((el) => el.textContent);
    expect(confidences).toEqual(['82% confidence', '61% confidence']);

    const links = body.querySelectorAll('.fontcia-source-link');
    expect(links).toHaveLength(2);
  });

  it('shows independent saved state per candidate when logged in', () => {
    const body = document.createElement('div');

    renderRankedMatchesState(body, candidates, [false, true], vi.fn(), vi.fn(), true, vi.fn());

    const saveButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(saveButtons).toHaveLength(2);
    expect(saveButtons[0].textContent).toBe('☆ Save');
    expect(saveButtons[1].textContent).toBe('★ Saved');
  });

  it("calls onToggleSave with the clicked candidate's own index", () => {
    const body = document.createElement('div');
    const onToggleSave = vi.fn();

    renderRankedMatchesState(body, candidates, [false, false], onToggleSave, vi.fn(), true, vi.fn());

    const saveButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    saveButtons[1].click();

    expect(onToggleSave).toHaveBeenCalledWith(1);
    expect(onToggleSave).toHaveBeenCalledOnce();
  });

  it('shows "Log in to save" for every candidate instead of Save/Saved when not logged in', () => {
    const body = document.createElement('div');

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), false, vi.fn());

    const loginButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(loginButtons).toHaveLength(2);
    expect(loginButtons.every((btn) => btn.textContent === 'Log in to save')).toBe(true);
  });

  it('calls onLoginPrompt when a "Log in to save" button is clicked', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), false, onLoginPrompt);

    const loginButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    loginButtons[0].click();

    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });

  it('renders exactly one shared New scan button, not one per candidate', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), onNewScan, true, vi.fn());

    const newScanButtons = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).filter(
      (btn) => btn.textContent === 'New scan',
    );
    expect(newScanButtons).toHaveLength(1);

    (newScanButtons[0] as HTMLButtonElement).click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });

  it('clears any previous content before rendering', () => {
    const body = document.createElement('div');
    body.textContent = 'stale content';

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), true, vi.fn());

    expect(body.textContent).not.toContain('stale content');
  });
});

describe('renderNoConfidentMatchState', () => {
  it('renders distinct copy from renderNoMatchState, with a New scan button', () => {
    const body = document.createElement('div');

    renderNoConfidentMatchState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoConfidentMatchState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderMatchErrorState', () => {
  it('renders distinct copy from the other message states, with a New scan button', () => {
    const body = document.createElement('div');

    renderMatchErrorState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong analyzing this image.',
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderMatchErrorState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
```

Also change the import block at the top of `tests/scan-dialogue.test.ts` from:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
} from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';
```
to:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
} from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';
import type { RankedMatch } from '../src/shared/match-messages';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: FAIL — `renderRankedMatchesState`, `renderNoConfidentMatchState`, `renderMatchErrorState` are not exported by `../src/content/scan-dialogue`.

- [ ] **Step 3: Add the three new render functions to `src/content/scan-dialogue.ts`**

Change the import at the top of `src/content/scan-dialogue.ts` from:
```ts
import type { MatchResult } from './scan-types';
```
to:
```ts
import type { MatchResult } from './scan-types';
import type { RankedMatch } from '../shared/match-messages';
```

Add these three functions at the end of the file, after the existing `renderCaptureBlockedState`:

```ts
export function renderRankedMatchesState(
  body: HTMLElement,
  candidates: RankedMatch[],
  savedFlags: boolean[],
  onToggleSave: (index: number) => void,
  onNewScan: () => void,
  isLoggedIn: boolean,
  onLoginPrompt: () => void,
): void {
  body.replaceChildren();

  const list = document.createElement('div');
  list.className = 'fontcia-match-list';

  candidates.forEach((candidate, index) => {
    const item = document.createElement('div');
    item.className = 'fontcia-match-item';

    const name = document.createElement('div');
    name.className = 'fontcia-match-name';
    name.textContent = candidate.fontName;
    item.appendChild(name);

    const confidence = document.createElement('div');
    confidence.className = 'fontcia-match-confidence';
    confidence.textContent = `${candidate.confidence}% confidence`;
    item.appendChild(confidence);

    const sourcesList = document.createElement('ul');
    sourcesList.className = 'fontcia-sources';
    for (const source of candidate.sources) {
      const sourceItem = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'fontcia-source-link';
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.label;
      sourceItem.appendChild(link);
      sourcesList.appendChild(sourceItem);
    }
    item.appendChild(sourcesList);

    const actions = document.createElement('div');
    actions.className = 'fontcia-result-actions';

    if (isLoggedIn) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'fontcia-btn fontcia-btn-primary';
      saveBtn.dataset.candidateIndex = String(index);
      saveBtn.textContent = savedFlags[index] ? '★ Saved' : '☆ Save';
      saveBtn.addEventListener('click', () => onToggleSave(index));
      actions.appendChild(saveBtn);
    } else {
      const loginBtn = document.createElement('button');
      loginBtn.type = 'button';
      loginBtn.className = 'fontcia-btn fontcia-btn-primary';
      loginBtn.textContent = 'Log in to save';
      loginBtn.addEventListener('click', onLoginPrompt);
      actions.appendChild(loginBtn);
    }

    item.appendChild(actions);
    list.appendChild(item);
  });

  body.appendChild(list);

  const sharedActions = document.createElement('div');
  sharedActions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  sharedActions.appendChild(newScanBtn);

  body.appendChild(sharedActions);
}

export function renderNoConfidentMatchState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "Couldn't find a confident match for this font.";
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

export function renderMatchErrorState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = 'Something went wrong analyzing this image.';
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

`renderNoConfidentMatchState` and `renderMatchErrorState` are structurally identical to the existing `renderCaptureBlockedState` (just different copy) — kept as separate, fully-independent functions rather than extracted into a shared helper, matching this file's established convention (`renderNoMatchState` and `renderCaptureBlockedState` are already near-duplicates of each other with no shared helper) and this sub-project's own design principle: each situation gets its own function so a future change to one doesn't silently affect a different situation that happens to look similar today.

- [ ] **Step 4: Add the new CSS to `src/content/theme.ts`**

Change the end of `src/content/theme.ts` from:
```ts
.fontcia-analyzing-message {
  font-size: 12px;
  color: var(--fontcia-text);
  margin-top: 10px;
}
`;
```
to:
```ts
.fontcia-analyzing-message {
  font-size: 12px;
  color: var(--fontcia-text);
  margin-top: 10px;
}

.fontcia-match-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 280px;
  overflow-y: auto;
}

.fontcia-match-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--fontcia-border);
}

.fontcia-match-item:last-child {
  border-bottom: none;
}

.fontcia-match-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--fontcia-text);
}

.fontcia-match-confidence {
  font-size: 12px;
  color: var(--fontcia-text);
}
`;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — all tests in the file pass, including the new ones.

- [ ] **Step 6: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/content/scan-dialogue.ts src/content/theme.ts tests/scan-dialogue.test.ts
git commit -m "feat: add ranked-matches, no-confident-match, and match-error UI states"
```

---

### Task 5: `locked-selection.ts` Wiring

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts`

This is the task that actually connects everything built in Tasks 1-4 to the capture pipeline. It removes the `capturedImageBlob` closure variable (which has been unused-beyond-logging since the image-capture-pipeline sub-project) and replaces the frozen "stays on Analyzing image…" branch with a real `MATCH_IMAGE` round trip and one of the three new render states.

- [ ] **Step 1: Update the existing stale test and write the new failing tests**

The existing test `'holds the captured Blob and logs it, staying on the analyzing state, on a successful capture'` in `tests/locked-selection.test.ts` asserts the OLD behavior (frozen state, `console.log` call) that this task removes. Replace it and add new tests.

Change the import block at the top of `tests/locked-selection.test.ts` from:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderLockedSelection } from '../src/content/locked-selection';
import type { ScanResult } from '../src/content/scan-types';
import type { CaptureResponse } from '../src/shared/capture-messages';
```
to:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderLockedSelection } from '../src/content/locked-selection';
import type { ScanResult } from '../src/content/scan-types';
import type { CaptureResponse } from '../src/shared/capture-messages';
import type { MatchImageResponse } from '../src/shared/match-messages';
```

Find this existing test (it's the one right after `'scales the CAPTURE_SELECTION message by the real window.devicePixelRatio'` and right before `'renders the capture-blocked state when the response is blocked'`):
```ts
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
```

Replace it entirely with these seven tests:

```ts
  it('sends MATCH_IMAGE with the captured blob after a successful capture', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    const matchDeferred = createDeferred<MatchImageResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return matchDeferred.promise;
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
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'MATCH_IMAGE', blob: fakeBlob });
  });

  it('renders ranked matches and logs the top candidate as a match when MATCH_IMAGE succeeds with candidates', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') {
        return {
          status: 'ok',
          matches: [
            {
              fontName: 'Inter',
              confidence: 82,
              sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
            },
            {
              fontName: 'Roboto',
              confidence: 61,
              sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
            },
          ],
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
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
    await Promise.resolve();
    await Promise.resolve();

    const names = Array.from(panel.querySelectorAll('.fontcia-match-name')).map((el) => el.textContent);
    expect(names).toEqual(['Inter', 'Roboto']);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOG_SCAN',
      status: 'match',
      fontName: 'Inter',
      confidence: 82,
    });
  });

  it('renders the no-confident-match state and logs no-match when MATCH_IMAGE succeeds with an empty array', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return { status: 'ok', matches: [] };
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
  });

  it('renders the match-error state and logs no-match when MATCH_IMAGE resolves with an error status', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return { status: 'error', message: 'embedding service unreachable' };
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong analyzing this image.',
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
  });

  it('renders the match-error state when the MATCH_IMAGE message itself rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') throw new Error('service worker unreachable');
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong analyzing this image.',
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('fontCIA: image match message failed', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('does not render a match result after dispose() while MATCH_IMAGE is still pending', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    const matchDeferred = createDeferred<MatchImageResponse>();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return matchDeferred.promise;
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
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();

    dispose();
    matchDeferred.resolve({ status: 'ok', matches: [{ fontName: 'Inter', confidence: 90, sources: [] }] });
    await matchDeferred.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-match-name')).toBeNull();
    expect(panel.querySelector('.fontcia-analyzing-message')).not.toBeNull();
  });

  it('saves a candidate via SAVE_FONT using its own fontName/confidence/sources, independent of other candidates', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') {
        return {
          status: 'ok',
          matches: [
            {
              fontName: 'Inter',
              confidence: 82,
              sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
            },
            {
              fontName: 'Roboto',
              confidence: 61,
              sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
            },
          ],
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'SAVE_FONT') return { ok: true, data: { id: 'saved-1' } };
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
    await Promise.resolve();
    await Promise.resolve();

    const saveButtons = Array.from(panel.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(saveButtons).toHaveLength(2);
    expect(saveButtons[0].textContent).toBe('☆ Save');
    expect(saveButtons[1].textContent).toBe('☆ Save');

    saveButtons[1].click(); // save the SECOND candidate (Roboto)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_FONT',
      fontName: 'Roboto',
      confidence: 61,
      sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
    });

    const saveButtonsAfter = Array.from(panel.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(saveButtonsAfter[0].textContent).toBe('☆ Save'); // Inter unaffected
    expect(saveButtonsAfter[1].textContent).toBe('★ Saved'); // Roboto now saved
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — the new tests fail because `MATCH_IMAGE` is never sent (the old code just logs and freezes); `.fontcia-match-name`/`.fontcia-match-item` never appear.

- [ ] **Step 3: Update `src/content/locked-selection.ts`**

Change the import block at the top from:
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
to:
```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult, ImageMatchResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse, RankedMatch } from '../shared/match-messages';
import { resolveFontFromSelection } from './font-resolver';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
} from './scan-dialogue';
```

Change the closure state block from:
```ts
  // State is scoped to this one closure — a fresh instance every time a
  // selection locks, never module-level, so there's no cross-instance leakage.
  let disposed = false;
  let savedFontId: string | null = null;
  let currentResult: MatchResult | null = null;
  // Guards the SAVE_FONT/DELETE_SAVED_FONT round trip against two distinct
  // hazards: (1) a chrome.storage.onChanged fire — routinely triggered by the
  // very request in flight, since a 401-refresh-and-retry inside api-client.ts
  // writes to the same 'fontcia-auth' key this file listens on — re-rendering
  // a fresh, non-disabled button mid-request; and (2) a second click landing
  // while the first request is still outstanding. Both are closed by the same
  // flag: renderResult() no-ops while it's set, and handleToggleSave() itself
  // refuses to start a second round trip while one is pending.
  let togglePending = false;
  // Held for a future sub-project's image-matching call — not read anywhere
  // in this sub-project, which is capture-and-crop plumbing only. Deliberately
  // still assigned (not just logged) so it survives past this closure's
  // console.log call, ready for that later consumer.
  let capturedImageBlob: Blob | null = null;
```
to:
```ts
  // State is scoped to this one closure — a fresh instance every time a
  // selection locks, never module-level, so there's no cross-instance leakage.
  let disposed = false;
  let savedFontId: string | null = null;
  let currentResult: MatchResult | null = null;
  // Guards the SAVE_FONT/DELETE_SAVED_FONT round trip against two distinct
  // hazards: (1) a chrome.storage.onChanged fire — routinely triggered by the
  // very request in flight, since a 401-refresh-and-retry inside api-client.ts
  // writes to the same 'fontcia-auth' key this file listens on — re-rendering
  // a fresh, non-disabled button mid-request; and (2) a second click landing
  // while the first request is still outstanding. Both are closed by the same
  // flag: renderResult() no-ops while it's set, and handleToggleSave() itself
  // refuses to start a second round trip while one is pending.
  let togglePending = false;
  // Same shape as currentResult/savedFontId/togglePending above, but the
  // image-match path can show several independently-saveable candidates at
  // once, so each piece of per-candidate state is its own parallel array
  // instead of a single scalar.
  let currentCandidates: RankedMatch[] | null = null;
  let candidateSavedIds: (string | null)[] = [];
  let candidateTogglePending: boolean[] = [];
```

Add `renderCandidates`, `showCandidates`, and `handleToggleCandidateSave` right after the existing `handleToggleSave` function (i.e., insert them between the end of `handleToggleSave` and the start of `handleNoTextResult`):

```ts
  async function renderCandidates(): Promise<void> {
    if (!currentCandidates) return;
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed || !currentCandidates) return;
    renderRankedMatchesState(
      body,
      currentCandidates,
      candidateSavedIds.map((id) => id !== null),
      handleToggleCandidateSave,
      onRestart,
      isLoggedIn,
      handleLoginPrompt,
    );
  }

  function showCandidates(candidates: RankedMatch[]): void {
    currentCandidates = candidates;
    candidateSavedIds = candidates.map(() => null);
    candidateTogglePending = candidates.map(() => false);
    void renderCandidates();
  }

  function handleToggleCandidateSave(index: number): void {
    if (!currentCandidates || candidateTogglePending[index]) return;
    const candidate = currentCandidates[index];
    candidateTogglePending[index] = true;
    const wasSaved = candidateSavedIds[index] !== null;
    const saveBtn = body.querySelector(`[data-candidate-index="${index}"]`) as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;

    if (wasSaved) {
      const idToDelete = candidateSavedIds[index] as string;
      sendApiMessage<null>({ type: 'DELETE_SAVED_FONT', id: idToDelete })
        .then((res) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          if (res.ok) {
            candidateSavedIds[index] = null;
          } else {
            console.error('fontCIA: unsave failed', res.error);
          }
          void renderCandidates();
        })
        .catch((error: unknown) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          console.error('fontCIA: unsave failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    } else {
      const { fontName, confidence, sources } = candidate;
      sendApiMessage<{ id: string }>({ type: 'SAVE_FONT', fontName, confidence, sources })
        .then((res) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          if (res.ok) {
            candidateSavedIds[index] = res.data.id;
          } else {
            console.error('fontCIA: save failed', res.error);
          }
          void renderCandidates();
        })
        .catch((error: unknown) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          console.error('fontCIA: save failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    }
  }
```

Change `handleNoTextResult` from:
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
          console.log('fontCIA: captured image for analysis', capturedImageBlob);
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
to:
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
          handleImageCapture(response.blob);
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

  function logImageMatchResult(result: ImageMatchResult): void {
    const message: ApiMessage =
      result.status === 'matches'
        ? {
            type: 'LOG_SCAN',
            status: 'match',
            fontName: result.candidates[0].fontName,
            confidence: result.candidates[0].confidence,
          }
        : { type: 'LOG_SCAN', status: 'no-match' };
    sendApiMessage<null>(message).catch((error: unknown) => {
      console.error('fontCIA: scan logging failed', error);
    });
  }

  function renderImageMatchResult(result: ImageMatchResult): void {
    if (result.status === 'matches') {
      showCandidates(result.candidates);
    } else if (result.status === 'no-confident-match') {
      renderNoConfidentMatchState(body, onRestart);
    } else {
      renderMatchErrorState(body, onRestart);
    }
  }

  function handleImageCapture(blob: Blob): void {
    const message: MatchImageMessage = { type: 'MATCH_IMAGE', blob };
    chrome.runtime
      .sendMessage(message)
      .then((response: MatchImageResponse) => {
        if (disposed) return;
        const result: ImageMatchResult =
          response.status === 'ok'
            ? response.matches.length > 0
              ? { status: 'matches', candidates: response.matches }
              : { status: 'no-confident-match' }
            : { status: 'error' };
        logImageMatchResult(result);
        renderImageMatchResult(result);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error('fontCIA: image match message failed', error);
        renderMatchErrorState(body, onRestart);
      });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — all tests in the file pass, including the 7 new/replaced ones.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: wire the captured image Blob to /font-matches and render real results"
```

---

### Task 6: Final Verification

**Files:** None (verification only).

- [ ] **Step 1: Full typecheck and test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; every test file passes, including all changes from Tasks 1-5.

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: builds cleanly with no errors, producing the bundled extension output (matching how every prior sub-project's final verification step confirmed the build itself, not just the test suite, stays green).

- [ ] **Step 3: Optional manual smoke test**

This step requires the full stack running: `docker compose up -d` and the embedding-service (`uvicorn main:app --port 8000`) and the Node server (`npm run start` from `server/`) all up, per `server/README.md` and `embedding-service/README.md` — the same three-service setup verified end-to-end in the font-matching-backend sub-project's Task 8. With all three running and the extension loaded unpacked in Chrome (`chrome://extensions` → Load unpacked → this repo's build output directory):

1. Navigate to a page with an image containing no real DOM text where a font could plausibly render (or any page where DOM font-resolution would report `no-text` — the easiest reliable trigger is scanning over a `<canvas>` or `<img>` element).
2. Trigger a scan. Confirm "Analyzing image…" appears, then either a ranked list of candidates, a "Couldn't find a confident match for this font." message, or (if a service isn't running) "Something went wrong analyzing this image."
3. If candidates appear, confirm each has its own Save button that independently toggles to "★ Saved" without affecting the other candidates' buttons.
4. Confirm "New scan" resets the panel back to the ready state from any of the three new states.

This step is optional given the thorough automated coverage from Tasks 1-5, but is the only way to see the real, honestly-uncertain ranked-list UI actually render against real backend output — worth doing at least once before considering this sub-project fully done.

- [ ] **Step 4: If a real, fixable bug was found in Step 3**, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix. If nothing broke, there's nothing to commit for this task beyond the verification itself.

---

## Self-Review Notes

- **Spec coverage:** new `match-messages.ts` sibling to `capture-messages.ts` (Task 1) → covered; background-script fetch in `matchImage()` (Task 2) → covered; third `onMessage` branch (Task 3) → covered; parallel `ImageMatchResult` type, not extending `ScanResult` (Task 1) → covered; three distinctly-named UI states with distinct copy (Task 4) → covered; loading state reused unchanged, no new sub-states (Task 5, `renderAnalyzingImageState` untouched) → covered; per-candidate independent save state reusing `SAVE_FONT` unchanged (Task 5) → covered; scan logging reused unchanged, top-candidate-as-match / empty-as-no-match (Task 5, `logImageMatchResult`) → covered; the disclosed technical-debt note about `/scans` not distinguishing DOM vs. image-path scans is documented in the spec itself (not a code task — nothing further needed here since the spec is the durable record the user asked for).
- **Placeholder scan:** none found — every step has complete, runnable code, including the full new/replaced test suites (not truncated).
- **Type consistency check:** `RankedMatch` (Task 1) is imported and used identically in `api-client.ts` (Task 2, as `matchImage`'s return type parameter), `service-worker.ts` (Task 3, via `MatchImageResponse`), `scan-dialogue.ts` (Task 4, `renderRankedMatchesState`'s `candidates` parameter), and `scan-types.ts`/`locked-selection.ts` (Task 1/5, `ImageMatchResult['candidates']`) — no reimplementation, no drift. `MatchImageMessage`/`MatchImageResponse` (Task 1) match exactly between `service-worker.ts`'s `handleMatchImageMessage` signature (Task 3) and `locked-selection.ts`'s `handleImageCapture` usage (Task 5). `renderRankedMatchesState`/`renderNoConfidentMatchState`/`renderMatchErrorState`'s signatures (Task 4) match their call sites in `locked-selection.ts` (Task 5) exactly — same parameter order, same types. The `data-candidate-index` attribute set in `scan-dialogue.ts` (Task 4) matches the selector `locked-selection.ts`'s `handleToggleCandidateSave` queries for (Task 5).
