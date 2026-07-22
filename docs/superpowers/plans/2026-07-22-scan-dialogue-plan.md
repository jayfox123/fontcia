# Scan Dialogue UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Step 1's static placeholder panel body with a real four-state dialogue (ready / loading / result / no-match) driven by a mocked scan, deterministic on the drawn box's pixel width, with a `dispose()` mechanism proven to cancel an in-flight mock scan through every real dismiss path (Esc, panel close, icon toggle-off).

**Architecture:** Two new pure modules (`mock-scan.ts` for the mocked "backend call," `scan-dialogue.ts` for stateless per-state DOM builders) plug into `locked-selection.ts`, which gains a closure-scoped state machine and a `dispose()` export. `overlay.ts` hooks that `dispose()` into its single existing `teardownOverlay()` function — since all three dismiss triggers already converge there (established in Step 1) — and gains a `restartSelection()` used by the dialogue's "New scan" button.

**Tech Stack:** Manifest V3, vanilla TypeScript (no framework), Vitest + jsdom for unit tests, `vi.mock` for module-level test doubles.

---

## File Structure

- `src/content/mock-scan.ts` (new) — pure, no DOM: `mockScan(rect, delayMs)` resolves match/no-match deterministically on `rect.width`
- `src/content/scan-dialogue.ts` (new) — pure DOM builders, one per state: `renderReadyState`, `renderLoadingState`, `renderResultState`, `renderNoMatchState`
- `src/content/theme.ts` (modified) — adds button, spinner, and result/no-match CSS classes
- `src/content/locked-selection.ts` (modified) — replaces the static placeholder body with a closure-scoped state machine wiring Scan/Save/New-scan, exposes `dispose()`
- `src/content/overlay.ts` (modified) — hooks `dispose()` into `teardownOverlay()`, adds `restartSelection()`, `armSelectionMode` now marks the tab active
- `tests/mock-scan.test.ts` (new), `tests/scan-dialogue.test.ts` (new), `tests/locked-selection.test.ts` (modified), `tests/overlay.test.ts` (modified), `tests/overlay-dialogue-integration.test.ts` (new)

---

### Task 1: Mock Scan Module

**Files:**
- Create: `src/content/mock-scan.ts`
- Test: `tests/mock-scan.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/mock-scan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mockScan, NO_MATCH_WIDTH_THRESHOLD_PX } from '../src/content/mock-scan';

describe('mockScan', () => {
  it('resolves no-match for a rect narrower than the threshold', async () => {
    const result = await mockScan({ x: 0, y: 0, width: NO_MATCH_WIDTH_THRESHOLD_PX - 1, height: 20 }, 1);
    expect(result).toEqual({ status: 'no-match' });
  });

  it('resolves match for a rect at or above the threshold', async () => {
    const result = await mockScan({ x: 0, y: 0, width: NO_MATCH_WIDTH_THRESHOLD_PX, height: 20 }, 1);
    expect(result.status).toBe('match');
  });

  it('includes a non-empty sources array on match', async () => {
    const result = await mockScan({ x: 0, y: 0, width: 200, height: 20 }, 1);
    if (result.status !== 'match') throw new Error('expected match');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]).toHaveProperty('url');
    expect(result.sources[0]).toHaveProperty('label');
    expect(result.sources[0]).toHaveProperty('votes');
  });

  it('does not resolve before the delay elapses', async () => {
    let resolved = false;
    void mockScan({ x: 0, y: 0, width: 200, height: 20 }, 20).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resolved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mock-scan.test.ts`
Expected: FAIL — `Cannot find module '../src/content/mock-scan'`

- [ ] **Step 3: Write minimal implementation**

`src/content/mock-scan.ts`:

```ts
import type { Rect } from '../shared/selection-box';

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
}

export type ScanResult = MatchResult | NoMatchResult;

export const NO_MATCH_WIDTH_THRESHOLD_PX = 80;
export const MOCK_SCAN_DELAY_MS = 700;

const MOCK_MATCH_FIXTURE: Omit<MatchResult, 'status'> = {
  fontName: 'Inter',
  confidence: 92,
  sources: [
    { url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 14 },
    { url: 'https://rsms.me/inter/', label: 'Official site', votes: 6 },
  ],
};

export function mockScan(rect: Rect, delayMs: number = MOCK_SCAN_DELAY_MS): Promise<ScanResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (rect.width < NO_MATCH_WIDTH_THRESHOLD_PX) {
        resolve({ status: 'no-match' });
      } else {
        resolve({ status: 'match', ...MOCK_MATCH_FIXTURE });
      }
    }, delayMs);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mock-scan.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/content/mock-scan.ts tests/mock-scan.test.ts
git commit -m "feat: add mocked scan resolving match/no-match by selection box width"
```

---

### Task 2: Theme CSS Additions

**Files:**
- Modify: `src/content/theme.ts`

- [ ] **Step 1: Replace the full file with the extended token set**

The current file (unchanged parts of the surface/box/panel/notch/header/close rules stay exactly as they are) gains new button, spinner, and result/no-match classes, and `.fontcia-panel-body`'s color changes from the old hardcoded success-green (which only made sense for the single placeholder line) to the neutral text color, since the body now hosts four different states each with their own specific colors.

`src/content/theme.ts` (full replacement):

```ts
export const themeCss = `
.fontcia-surface {
  --fontcia-bg: #14171A;
  --fontcia-surface: #1F242B;
  --fontcia-text: #E8E6E1;
  --fontcia-accent: #FF6A3D;
  --fontcia-success: #3FA796;
  --fontcia-border: #2A2F36;

  position: fixed;
  inset: 0;
  cursor: crosshair;
}

/* Light tokens are wired now so a future toggle is a class swap, not a restyle. Not applied anywhere yet. */
.fontcia-surface.theme-light {
  --fontcia-bg: #FFFFFF;
  --fontcia-surface: #F4F4F5;
  --fontcia-text: #18181B;
  --fontcia-accent: #FF6A3D;
  --fontcia-success: #16A34A;
  --fontcia-border: #E5E5E7;
}

.fontcia-draft-box,
.fontcia-box {
  position: fixed;
  border: 2px dashed var(--fontcia-accent);
  background: rgba(255, 106, 61, 0.1);
  pointer-events: none;
}

.fontcia-panel {
  position: fixed;
  min-width: 180px;
  background: var(--fontcia-surface);
  border: 1px solid var(--fontcia-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font-family: system-ui, sans-serif;
  font-size: 13px;
  color: var(--fontcia-text);
  padding: 10px 14px;
  pointer-events: auto;
}

.fontcia-notch {
  position: absolute;
  top: -8px;
  left: 24px;
  width: 0;
  height: 0;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-bottom: 8px solid var(--fontcia-surface);
}

.fontcia-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.fontcia-panel-close {
  cursor: pointer;
  opacity: 0.6;
}

.fontcia-panel-close:hover {
  opacity: 1;
}

.fontcia-panel-body {
  color: var(--fontcia-text);
  font-size: 12px;
}

.fontcia-btn {
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.fontcia-btn-primary {
  background: var(--fontcia-accent);
  color: #ffffff;
}

.fontcia-btn-secondary {
  background: transparent;
  border: 1px solid var(--fontcia-border);
  color: var(--fontcia-text);
}

.fontcia-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.fontcia-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--fontcia-border);
  border-top-color: var(--fontcia-accent);
  border-radius: 50%;
  animation: fontcia-spin 0.8s linear infinite;
}

@keyframes fontcia-spin {
  to {
    transform: rotate(360deg);
  }
}

.fontcia-result-font {
  font-size: 15px;
  font-weight: 600;
}

.fontcia-confidence {
  color: var(--fontcia-success);
  font-size: 12px;
  margin-top: 2px;
}

.fontcia-sources {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 96px;
  overflow-y: auto;
}

.fontcia-source-link {
  display: block;
  color: var(--fontcia-text);
  font-size: 12px;
  text-decoration: none;
  padding: 2px 0;
}

.fontcia-source-link:hover {
  text-decoration: underline;
}

.fontcia-result-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.fontcia-no-match-message {
  font-size: 12px;
  color: var(--fontcia-text);
  margin-bottom: 10px;
}
`;
```

- [ ] **Step 2: Verify the full test suite and typecheck still pass**

Run: `npm run typecheck && npm test`
Expected: `tsc --noEmit` produces no errors; all existing tests still pass (this is a CSS-only change — no test asserts `.fontcia-panel-body`'s color, so nothing should break).

- [ ] **Step 3: Commit**

```bash
git add src/content/theme.ts
git commit -m "feat: add button, spinner, and result/no-match CSS classes"
```

---

### Task 3: Scan Dialogue — Ready & Loading States

**Files:**
- Create: `src/content/scan-dialogue.ts`
- Test: `tests/scan-dialogue.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/scan-dialogue.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderReadyState, renderLoadingState } from '../src/content/scan-dialogue';

describe('renderReadyState', () => {
  it('renders a Scan button that calls onScan when clicked', () => {
    const body = document.createElement('div');
    const onScan = vi.fn();

    renderReadyState(body, onScan);

    const btn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Scan');

    btn.click();
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('clears any previous content before rendering', () => {
    const body = document.createElement('div');
    body.textContent = 'stale content';

    renderReadyState(body, vi.fn());

    expect(body.textContent).not.toContain('stale content');
  });
});

describe('renderLoadingState', () => {
  it('renders a spinner with no interactive elements', () => {
    const body = document.createElement('div');

    renderLoadingState(body);

    expect(body.querySelector('.fontcia-spinner')).not.toBeNull();
    expect(body.querySelector('button')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: FAIL — `Cannot find module '../src/content/scan-dialogue'`

- [ ] **Step 3: Write minimal implementation**

`src/content/scan-dialogue.ts`:

```ts
export function renderReadyState(body: HTMLElement, onScan: () => void): void {
  body.replaceChildren();

  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'fontcia-btn fontcia-btn-primary';
  scanBtn.textContent = 'Scan';
  scanBtn.addEventListener('click', onScan);

  body.appendChild(scanBtn);
}

export function renderLoadingState(body: HTMLElement): void {
  body.replaceChildren();

  const spinner = document.createElement('div');
  spinner.className = 'fontcia-spinner';

  body.appendChild(spinner);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/content/scan-dialogue.ts tests/scan-dialogue.test.ts
git commit -m "feat: add ready and loading state renderers for the scan dialogue"
```

---

### Task 4: Scan Dialogue — Result & No-Match States

**Files:**
- Modify: `src/content/scan-dialogue.ts`
- Modify: `tests/scan-dialogue.test.ts`

- [ ] **Step 1: Write the failing tests (append to `tests/scan-dialogue.test.ts`)**

Add these imports at the top of `tests/scan-dialogue.test.ts` (alongside the existing ones):

```ts
import { renderResultState, renderNoMatchState } from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/mock-scan';
```

Add these `describe` blocks at the end of the file:

```ts
describe('renderResultState', () => {
  const result: MatchResult = {
    status: 'match',
    fontName: 'Inter',
    confidence: 92,
    sources: [
      { url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 14 },
      { url: 'https://rsms.me/inter/', label: 'Official site', votes: 6 },
    ],
  };

  it('renders the font name, confidence, and all sources', () => {
    const body = document.createElement('div');

    renderResultState(body, result, false, vi.fn(), vi.fn());

    expect(body.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');
    expect(body.querySelector('.fontcia-confidence')?.textContent).toBe('92% confidence');

    const links = body.querySelectorAll('.fontcia-source-link');
    expect(links.length).toBe(2);
    expect((links[0] as HTMLAnchorElement).href).toBe('https://fonts.google.com/specimen/Inter');
  });

  it('shows unsaved state and calls onToggleSave on click', () => {
    const body = document.createElement('div');
    const onToggleSave = vi.fn();

    renderResultState(body, result, false, onToggleSave, vi.fn());

    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');

    saveBtn.click();
    expect(onToggleSave).toHaveBeenCalledOnce();
  });

  it('shows saved state when saved is true', () => {
    const body = document.createElement('div');

    renderResultState(body, result, true, vi.fn(), vi.fn());

    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('★ Saved');
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderResultState(body, result, false, vi.fn(), onNewScan);

    const newScanBtn = body.querySelector('.fontcia-btn-secondary') as HTMLButtonElement;
    expect(newScanBtn.textContent).toBe('New scan');

    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderNoMatchState', () => {
  it('renders a message and a disabled Name-it button', () => {
    const body = document.createElement('div');

    renderNoMatchState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')).not.toBeNull();

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoMatchState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;

    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: FAIL — `renderResultState`/`renderNoMatchState` are not exported yet

- [ ] **Step 3: Write minimal implementation**

Add these to `src/content/scan-dialogue.ts` (append; keep `renderReadyState`/`renderLoadingState` from Task 3 unchanged), plus add this import at the top of the file:

```ts
import type { MatchResult } from './mock-scan';
```

```ts
export function renderResultState(
  body: HTMLElement,
  result: MatchResult,
  saved: boolean,
  onToggleSave: () => void,
  onNewScan: () => void,
): void {
  body.replaceChildren();

  const fontName = document.createElement('div');
  fontName.className = 'fontcia-result-font';
  fontName.textContent = result.fontName;
  body.appendChild(fontName);

  const confidence = document.createElement('div');
  confidence.className = 'fontcia-confidence';
  confidence.textContent = `${result.confidence}% confidence`;
  body.appendChild(confidence);

  const sourcesList = document.createElement('ul');
  sourcesList.className = 'fontcia-sources';
  for (const source of result.sources) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'fontcia-source-link';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.label;
    item.appendChild(link);
    sourcesList.appendChild(item);
  }
  body.appendChild(sourcesList);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'fontcia-btn fontcia-btn-primary';
  saveBtn.textContent = saved ? '★ Saved' : '☆ Save';
  saveBtn.addEventListener('click', onToggleSave);
  actions.appendChild(saveBtn);

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderNoMatchState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "We don't recognize this one.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const nameItBtn = document.createElement('button');
  nameItBtn.type = 'button';
  nameItBtn.className = 'fontcia-btn fontcia-btn-secondary';
  nameItBtn.textContent = 'Name it';
  nameItBtn.disabled = true;
  actions.appendChild(nameItBtn);

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — 9 tests passed (3 from Task 3 + 6 new: 4 for renderResultState, 2 for renderNoMatchState)

- [ ] **Step 5: Commit**

```bash
git add src/content/scan-dialogue.ts tests/scan-dialogue.test.ts
git commit -m "feat: add result and no-match state renderers for the scan dialogue"
```

---

### Task 5: Wire the Dialogue into `locked-selection.ts` and `overlay.ts`

**Files:**
- Modify: `src/content/locked-selection.ts`
- Modify: `tests/locked-selection.test.ts`
- Modify: `src/content/overlay.ts`
- Modify: `tests/overlay.test.ts`

This task touches two files together because `locked-selection.ts`'s new required `onRestart` parameter has no caller until `overlay.ts`'s `restartSelection` exists — splitting them would leave the build broken between commits.

- [ ] **Step 1: Write the failing tests for `locked-selection.ts` (full replacement of `tests/locked-selection.test.ts`)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderLockedSelection } from '../src/content/locked-selection';
import type { ScanResult } from '../src/content/mock-scan';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('renderLockedSelection', () => {
  it('renders a box positioned to the rect', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { box } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());

    expect(box.className).toBe('fontcia-box');
    expect(box.style.left).toBe('10px');
    expect(box.style.top).toBe('20px');
    expect(box.style.width).toBe('100px');
    expect(box.style.height).toBe('30px');
    expect(container.contains(box)).toBe(true);
  });

  it('renders a panel underneath the box with a notch and close button', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());

    expect(panel.className).toBe('fontcia-panel');
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('58px'); // rect.y + rect.height + 8px gap
    expect(panel.querySelector('.fontcia-notch')).not.toBeNull();
    expect(panel.querySelector('.fontcia-panel-close')).not.toBeNull();
    expect(container.contains(panel)).toBe(true);
  });

  it('calls onDismiss when the close button is clicked', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());
    const closeBtn = panel.querySelector('.fontcia-panel-close') as HTMLElement;
    closeBtn.click();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows the ready state with a Scan button initially', () => {
    const container = document.createElement('div');

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn());

    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(scanBtn.textContent).toBe('Scan');
  });

  it('transitions ready -> loading -> result when Scan is clicked and the mock resolves to a match', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();

    deferred.resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');
  });

  it('transitions ready -> loading -> no-match when the mock resolves to no-match', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 40, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();

    deferred.resolve({ status: 'no-match' });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-no-match-message')).not.toBeNull();
  });

  it('toggles saved state on the result view when Save is clicked', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

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

    const saveBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');

    saveBtn.click();
    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('★ Saved');
  });

  it('calls onRestart when New scan is clicked in the result state', async () => {
    const container = document.createElement('div');
    const onRestart = vi.fn();
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      onRestart,
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const newScanBtn = panel.querySelector('.fontcia-btn-secondary') as HTMLButtonElement;
    newScanBtn.click();

    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('does not render a result if dispose() is called before the mock resolves', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel, dispose } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    dispose();

    deferred.resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-result-font')).toBeNull();
    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — `renderLockedSelection` doesn't accept a 4th/5th argument yet, and the ready state doesn't exist yet (still the old static placeholder text)

- [ ] **Step 3: Replace `src/content/locked-selection.ts` in full**

```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './mock-scan';
import { mockScan } from './mock-scan';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from './scan-dialogue';

export interface LockedSelectionElements {
  box: HTMLDivElement;
  panel: HTMLDivElement;
  dispose: () => void;
}

function applyRect(el: HTMLDivElement, rect: Rect): void {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

export function renderLockedSelection(
  container: ParentNode,
  rect: Rect,
  onDismiss: () => void,
  onRestart: () => void,
  scanFn: (rect: Rect) => Promise<ScanResult> = mockScan,
): LockedSelectionElements {
  const box = document.createElement('div');
  box.className = 'fontcia-box';
  applyRect(box, rect);
  container.appendChild(box);

  const panel = document.createElement('div');
  panel.className = 'fontcia-panel';
  panel.style.left = `${rect.x}px`;
  panel.style.top = `${rect.y + rect.height + 8}px`;
  // Stop mouse events on the panel from bubbling to the drag surface underneath
  // it, so interacting with panel content (e.g. a future scrollable area) can't
  // be mistaken for a new drag gesture.
  panel.addEventListener('mousedown', (event) => event.stopPropagation());

  const notch = document.createElement('div');
  notch.className = 'fontcia-notch';
  panel.appendChild(notch);

  const header = document.createElement('div');
  header.className = 'fontcia-panel-header';

  const title = document.createElement('strong');
  title.textContent = 'Scan dialogue';
  header.appendChild(title);

  const closeBtn = document.createElement('span');
  closeBtn.className = 'fontcia-panel-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', onDismiss);
  header.appendChild(closeBtn);

  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'fontcia-panel-body';
  panel.appendChild(body);

  container.appendChild(panel);

  // State is scoped to this one closure — a fresh instance every time a
  // selection locks, never module-level, so there's no cross-instance leakage.
  let disposed = false;
  let saved = false;
  let currentResult: MatchResult | null = null;

  function showResult(result: MatchResult): void {
    currentResult = result;
    renderResultState(body, result, saved, handleToggleSave, onRestart);
  }

  function handleToggleSave(): void {
    if (!currentResult) return;
    saved = !saved;
    renderResultState(body, currentResult, saved, handleToggleSave, onRestart);
  }

  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect).then((result) => {
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
    });
  }

  renderReadyState(body, handleScan);

  function dispose(): void {
    disposed = true;
  }

  return { box, panel, dispose };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — 9 tests passed

- [ ] **Step 5: Write the failing test for `overlay.ts`'s new behavior (append to `tests/overlay.test.ts`)**

Add this test inside the existing `describe('armSelectionMode / dismissSelection', ...)` block in `tests/overlay.test.ts` (the file already imports `isSelectionActive`/`markSelectionActive` from Step 1 — no new import needed):

```ts
  it('marks the tab as selection-active when armed', async () => {
    armSelectionMode(1);

    await expect(isSelectionActive(1)).resolves.toBe(true);
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — `armSelectionMode` doesn't mark the flag active yet (only the background did, in Step 1)

- [ ] **Step 7: Replace `src/content/overlay.ts` in full**

```ts
import { clearSelectionActive, markSelectionActive } from '../shared/session-state';
import { normalizeDragRect, isNoOpDrag, type Point } from '../shared/selection-box';
import { renderLockedSelection } from './locked-selection';
import { themeCss } from './theme';

declare global {
  interface Window {
    __fontciaOverlayInjected?: boolean;
  }
}

let currentTabId: number | null = null;
let hostEl: HTMLDivElement | null = null;
let shadowSurface: HTMLDivElement | null = null;
let draftBox: HTMLDivElement | null = null;
let dragStart: Point | null = null;
let isDragging = false;
let isLocked = false;
let lockedDispose: (() => void) | null = null;

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    dismissSelection();
  }
}

function handleMouseDown(event: MouseEvent): void {
  // Only one locked selection per armed session — a second drag is ignored
  // until the first is dismissed, rather than stacking a duplicate box+panel.
  if (!shadowSurface || isLocked) return;
  draftBox?.remove();
  isDragging = true;
  dragStart = { x: event.clientX, y: event.clientY };
  draftBox = document.createElement('div');
  draftBox.className = 'fontcia-draft-box';
  shadowSurface.appendChild(draftBox);
}

function handleMouseMove(event: MouseEvent): void {
  if (!isDragging || !dragStart || !draftBox) return;
  const rect = normalizeDragRect(dragStart, { x: event.clientX, y: event.clientY });
  draftBox.style.left = `${rect.x}px`;
  draftBox.style.top = `${rect.y}px`;
  draftBox.style.width = `${rect.width}px`;
  draftBox.style.height = `${rect.height}px`;
}

function handleMouseUp(event: MouseEvent): void {
  if (!isDragging || !dragStart || !shadowSurface) return;
  const rect = normalizeDragRect(dragStart, { x: event.clientX, y: event.clientY });
  isDragging = false;
  draftBox?.remove();
  draftBox = null;
  dragStart = null;

  if (isNoOpDrag(rect)) return;

  const locked = renderLockedSelection(shadowSurface, rect, dismissSelection, restartSelection);
  lockedDispose = locked.dispose;
  isLocked = true;
  // The host stays in the DOM (it hosts the box/panel until dismiss), but
  // selection mode is otherwise fully off once locked — reset the cursor so
  // it doesn't keep showing crosshair over the rest of the page, and stop the
  // full-viewport host from capturing clicks outside the box/panel. Setting
  // this on the light-DOM host itself (not just the shadow-tree surface) is
  // what actually lets clicks fall through to the underlying page — the panel
  // opts back into pointer events via its own CSS rule (.fontcia-panel
  // { pointer-events: auto }), inherited by its close button, so both stay clickable.
  shadowSurface.style.cursor = 'default';
  if (hostEl) {
    hostEl.style.pointerEvents = 'none';
  }
}

function createOverlay(): void {
  if (hostEl !== null) {
    teardownOverlay();
  }

  hostEl = document.createElement('div');
  hostEl.id = 'fontcia-overlay-host';
  Object.assign(hostEl.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
  document.body.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = themeCss;
  shadow.appendChild(style);

  shadowSurface = document.createElement('div');
  shadowSurface.className = 'fontcia-surface';
  // Set inline as well as via the .fontcia-surface CSS rule: jsdom's element.style
  // only reflects the inline style attribute, not applied stylesheet rules, and this
  // keeps the crosshair guaranteed even if the <style> tag were ever parsed late.
  shadowSurface.style.cursor = 'crosshair';
  shadow.appendChild(shadowSurface);

  shadowSurface.addEventListener('mousedown', handleMouseDown);
  shadowSurface.addEventListener('mousemove', handleMouseMove);
  shadowSurface.addEventListener('mouseup', handleMouseUp);

  document.addEventListener('keydown', handleKeydown);
}

function teardownOverlay(): void {
  // Cancel any in-flight mock scan before anything else — this is what makes
  // dispose() actually fire for every real dismiss trigger (Esc, panel close,
  // and the DISMISS_SELECTION message all call dismissSelection(), which
  // calls this function), not just when dispose() is called directly.
  lockedDispose?.();
  lockedDispose = null;
  document.removeEventListener('keydown', handleKeydown);
  hostEl?.remove();
  hostEl = null;
  shadowSurface = null;
  draftBox = null;
  dragStart = null;
  isDragging = false;
  isLocked = false;
}

export function armSelectionMode(tabId: number): void {
  currentTabId = tabId;
  createOverlay();
  markSelectionActive(tabId).catch((error: unknown) =>
    console.error('fontCIA: failed to mark selection active', error),
  );
}

export function dismissSelection(): void {
  if (currentTabId !== null) {
    clearSelectionActive(currentTabId).catch((error: unknown) =>
      console.error('fontCIA: failed to clear selection-active flag', error),
    );
  }
  currentTabId = null;
  teardownOverlay();
}

function restartSelection(): void {
  const tabId = currentTabId;
  dismissSelection();
  if (tabId !== null) {
    armSelectionMode(tabId);
  }
}

// chrome.scripting.executeScript re-runs this entire script on every injection.
// A dismiss-then-rearm cycle on the same tab (no navigation) clears the
// selection-active flag, so the background injects again — without this guard
// that would register a second competing onMessage listener on top of the
// still-alive first one, producing duplicate overlays. No sender check is
// needed here: this extension declares no externally_connectable, so
// onMessage can only ever fire for messages from its own background/content
// contexts, never another extension or a web page.
if (!window.__fontciaOverlayInjected) {
  window.__fontciaOverlayInjected = true;

  chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number }) => {
    if (message?.type === 'ARM_SELECTION' && typeof message.tabId === 'number') {
      armSelectionMode(message.tabId);
    } else if (message?.type === 'DISMISS_SELECTION') {
      dismissSelection();
    }
  });
}
```

- [ ] **Step 8: Run the full test suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: `tsc --noEmit` clean; all test files pass (mock-scan, scan-dialogue, session-state, selection-box, service-worker, locked-selection, overlay, overlay-integration).

- [ ] **Step 9: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts src/content/overlay.ts tests/overlay.test.ts
git commit -m "feat: wire scan dialogue state machine into locked selection and overlay"
```

---

### Task 6: End-to-End Dispose and Restart Verification

**Files:**
- Create: `tests/overlay-dialogue-integration.test.ts`

This is the test that directly proves the requirement: an in-flight mock scan is cancelled through a **real** dismiss trigger (Escape), not just a direct call to `dispose()`. It uses `vi.mock` to replace `mock-scan.ts`'s export with a fast (15ms) stand-in for this file only, so the test doesn't need to wait out the real 700ms production delay — `overlay.ts` and `locked-selection.ts` run completely unmodified; only the module they import from is swapped.

- [ ] **Step 1: Write the failing tests**

`tests/overlay-dialogue-integration.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Rect } from '../src/shared/selection-box';
import type { ScanResult } from '../src/content/mock-scan';

vi.mock('../src/content/mock-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/content/mock-scan')>();
  return {
    ...actual,
    mockScan: vi.fn(
      (rect: Rect) =>
        new Promise<ScanResult>((resolve) => {
          setTimeout(() => {
            resolve(
              rect.width >= actual.NO_MATCH_WIDTH_THRESHOLD_PX
                ? { status: 'match', fontName: 'Inter', confidence: 92, sources: [] }
                : { status: 'no-match' },
            );
          }, 15);
        }),
    ),
  };
});

import { armSelectionMode, dismissSelection } from '../src/content/overlay';
import { isSelectionActive } from '../src/shared/session-state';

function dispatchMouse(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

afterEach(() => {
  dismissSelection();
  document.body.innerHTML = '';
});

describe('dispose on real dismiss paths cancels an in-flight scan', () => {
  it('does not render a result if Escape dismisses the selection while loading', async () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 200, 60);

    // Keep a direct reference to the panel *before* dismissing. This matters:
    // once Escape tears down the overlay, hostEl is removed from `document`,
    // so a `document.querySelector(...)` assertion would pass trivially
    // whether or not dispose() actually fired — it wouldn't prove anything.
    // Checking this retained (now-detached) node's own children directly is
    // what actually proves the pending scan's resolution never touched it.
    const panel = surface.querySelector('.fontcia-panel') as Element;
    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
    expect(panel.querySelector('.fontcia-result-font')).toBeNull();
    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();
  });
});

describe('restartSelection via New scan', () => {
  it('re-arms crosshair mode with a fresh overlay after a match', async () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 200, 60);

    const scanBtn = surface.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 25));

    const newScanBtn = Array.from(surface.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;
    newScanBtn.click();

    const newHost = document.getElementById('fontcia-overlay-host');
    expect(newHost).not.toBeNull();

    const newSurface = newHost?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;
    expect(newSurface.style.cursor).toBe('crosshair');
    expect(newSurface.querySelector('.fontcia-box')).toBeNull();

    await expect(isSelectionActive(1)).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlay-dialogue-integration.test.ts`
Expected: FAIL if any part of Task 5 is incomplete — since Task 5 is already done at this point in the plan, this should actually PASS immediately. If it fails, re-check Task 5's `overlay.ts` replacement was applied exactly as written (in particular, that `teardownOverlay()` calls `lockedDispose?.()` and that `renderLockedSelection` is called with `restartSelection` as the 4th argument).

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/overlay-dialogue-integration.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 4: Run the full suite one more time**

Run: `npm test`
Expected: all test files pass, including this new one.

- [ ] **Step 5: Commit**

```bash
git add tests/overlay-dialogue-integration.test.ts
git commit -m "test: prove dispose cancels an in-flight scan on real Escape dismiss, and New scan re-arms"
```

---

### Task 7: Build Verification and Manual Smoke Test

**Files:**
- None (verification only)

- [ ] **Step 1: Full suite, typecheck, and production build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass; `dist/background/service-worker.js`, `dist/content/overlay.js`, `dist/manifest.json` all produced with no errors.

- [ ] **Step 2: Manual verification checklist (load unpacked in Chrome from `dist/`)**

- **Ready state:** click the icon, drag a wide box (roughly 100px+ wide) over any text, confirm the panel shows a "Scan" button styled with the accent color.
- **Loading state:** click Scan, confirm the button disappears and a spinning ring appears briefly (under a second).
- **Result state (wide box):** confirm it shows a font name, a confidence percentage, at least one clickable source link (opens in a new tab), a "☆ Save" button, and a "New scan" button.
- **Save toggle:** click "☆ Save", confirm it changes to "★ Saved" without anything else in the panel changing.
- **No-match state (narrow box):** draw a narrow box (under ~80px wide) and Scan; confirm it shows a "we don't recognize this one" message, a visibly disabled "Name it" button, and a "New scan" button.
- **New scan:** from either the result or no-match state, click "New scan"; confirm the box and panel disappear and the crosshair cursor reappears, ready to draw a brand-new selection.
- **Dismiss during loading:** click Scan, then immediately press Escape (or click the icon again, or use the panel's `×` if it's still visible) before the spinner finishes; confirm no result ever flashes in afterward and the extension is fully dismissed.
- **Theme contrast:** as in Step 1, manually toggle the `theme-light` class in DevTools and confirm the new buttons/spinner/result text remain readable in both themes.

- [ ] **Step 3: Record results**

If all checks pass, this sub-project is complete. If a fix is required, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix, same as Step 1's process.

---

## Self-Review Notes

- **Spec coverage:** mock determinism on `rect.width` → Task 1; theme tokens/CSS → Task 2; four dialogue states → Tasks 3–4; `dispose()` + closure-scoped state machine in `locked-selection.ts` → Task 5; `dispose()` hooked into the single `teardownOverlay()` path (covering Esc/panel-close/icon-toggle-off without per-trigger logic) → Task 5, directly proven via a real Escape trigger → Task 6; `restartSelection()` + `armSelectionMode` marking the flag active → Task 5, proven end-to-end → Task 6; sources array (not single URL) in the mock shape → Task 1; manual visual verification → Task 7. All spec sections are covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `ScanResult`/`MatchResult`/`NoMatchResult`/`ScanSource` from `mock-scan.ts` are imported with matching names in `scan-dialogue.ts` and `locked-selection.ts`; `renderReadyState`/`renderLoadingState`/`renderResultState`/`renderNoMatchState` signatures in Tasks 3–4 match exactly how they're called in Task 5's `locked-selection.ts`; `LockedSelectionElements`'s `dispose` field name matches what Task 5's `overlay.ts` destructures (`const locked = renderLockedSelection(...); lockedDispose = locked.dispose;`).
