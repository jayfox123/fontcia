# fontCIA Extension Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fontCIA v1 extension shell — icon click arms a crosshair selection mode via a shadow-DOM overlay injected into the page, dragging draws a box, releasing locks it and shows a placeholder scan-dialogue panel, with a single canonical dismiss path (Esc / panel × / toggle-off-by-icon) and MV3-safe state persistence.

**Architecture:** A background service worker owns the icon-click → inject-and-arm / toggle-off decision, using `chrome.storage.session` (keyed by tabId) as the source of truth for whether a selection session is currently active in a tab — this state must survive the service worker being killed and restarted, per Manifest V3's ephemeral-worker constraint. The injected content script owns the full on-page lifecycle (crosshair, drag, lock, dismiss) inside an isolated shadow DOM. Geometry math and locked-selection rendering are split into small, independently testable pure modules; only the DOM lifecycle glue lives in the content script's stateful module.

**Tech Stack:** Manifest V3, vanilla TypeScript (no framework), esbuild for bundling, Vitest + jsdom for unit tests.

**Design correction vs. spec:** the spec's step 5 says the flag clears "on lock." This plan instead clears it only in the single dismiss path (Esc / panel × / toggle-off message) so the double-injection guard stays correct while a locked box+panel is still on screen — otherwise a second icon click during the locked state would re-inject a duplicate overlay instead of dismissing the first one. Nothing user-facing changes; this is purely which internal event clears the flag.

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `manifest.json` — project scaffolding
- `src/shared/selection-box.ts` — pure geometry: drag-rect normalization, no-op-drag threshold
- `src/shared/session-state.ts` — `chrome.storage.session` wrapper for the per-tab "selection active" flag
- `src/background/service-worker.ts` — icon-click handler: double-injection guard, inject content script, arm/dismiss messaging
- `src/content/theme.ts` — exported CSS string (both theme token sets; dark applied by default) injected into the shadow root
- `src/content/locked-selection.ts` — pure-ish DOM builder for the locked box + placeholder panel (layout B: notch, dashed border)
- `src/content/overlay.ts` — content script entry: shadow DOM creation/teardown, crosshair, drag lifecycle, dismiss paths, runtime message listener
- `tests/helpers/chrome-mock.ts` — reusable fake `chrome` object (storage.session, scripting, tabs, action, runtime) backed by an in-memory store and Vitest spies
- `tests/setup.ts` — Vitest global setup installing the chrome mock before any module import
- `tests/*.test.ts` — one test file per source module, plus one integration test for the full overlay lifecycle

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `manifest.json`
- Create: `esbuild.config.mjs`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fontcia",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.287",
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: installs without errors, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["chrome"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "fontCIA",
  "version": "0.1.0",
  "description": "Identify fonts on any webpage by selecting text.",
  "action": {
    "default_title": "fontCIA — select text to identify its font"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "permissions": ["activeTab", "scripting", "storage"]
}
```

- [ ] **Step 5: Create `esbuild.config.mjs`**

```js
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: { 'service-worker': 'src/background/service-worker.ts' },
  outdir: 'dist/background',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
});

await esbuild.build({
  entryPoints: { overlay: 'src/content/overlay.ts' },
  outdir: 'dist/content',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

copyFileSync('manifest.json', 'dist/manifest.json');
```

- [ ] **Step 6: Sanity-check the toolchain**

Run: `npx tsc --version && npx esbuild --version && npx vitest --version`
Expected: three version strings print with no errors. (The build itself isn't runnable yet — no `src/` files exist until Task 2 onward.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json manifest.json esbuild.config.mjs
git commit -m "chore: scaffold extension project (esbuild + vitest + MV3 manifest)"
```

---

### Task 2: Selection Geometry

**Files:**
- Create: `src/shared/selection-box.ts`
- Create: `vitest.config.ts`
- Test: `tests/selection-box.test.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
  },
});
```

- [ ] **Step 2: Write the failing test**

`tests/selection-box.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeDragRect, isNoOpDrag } from '../src/shared/selection-box';

describe('normalizeDragRect', () => {
  it('normalizes a drag down-and-right', () => {
    const rect = normalizeDragRect({ x: 10, y: 20 }, { x: 110, y: 70 });
    expect(rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('normalizes a drag up-and-left (inverted start/end)', () => {
    const rect = normalizeDragRect({ x: 110, y: 70 }, { x: 10, y: 20 });
    expect(rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
});

describe('isNoOpDrag', () => {
  it('treats a drag distance under the threshold as a no-op', () => {
    const rect = normalizeDragRect({ x: 0, y: 0 }, { x: 3, y: 0 });
    expect(isNoOpDrag(rect)).toBe(true);
  });

  it('treats a drag distance at or above the threshold as a real selection', () => {
    const rect = normalizeDragRect({ x: 0, y: 0 }, { x: 4, y: 0 });
    expect(isNoOpDrag(rect)).toBe(false);
  });

  it('measures no-op by total drag distance, not per-axis', () => {
    const rect = normalizeDragRect({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(isNoOpDrag(rect)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/selection-box.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/selection-box'`

- [ ] **Step 4: Write minimal implementation**

`src/shared/selection-box.ts`:

```ts
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NO_OP_DRAG_THRESHOLD_PX = 4;

export function normalizeDragRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function isNoOpDrag(rect: Rect): boolean {
  return Math.hypot(rect.width, rect.height) < NO_OP_DRAG_THRESHOLD_PX;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/selection-box.test.ts`
Expected: PASS — 5 tests passed

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts src/shared/selection-box.ts tests/selection-box.test.ts
git commit -m "feat: add drag-rect normalization and no-op-drag threshold"
```

---

### Task 3: Session-State Storage Helper

**Files:**
- Create: `src/shared/session-state.ts`
- Create: `tests/helpers/chrome-mock.ts`
- Create: `tests/setup.ts`
- Modify: `vitest.config.ts`
- Test: `tests/session-state.test.ts`

- [ ] **Step 1: Create the reusable chrome mock**

`tests/helpers/chrome-mock.ts`:

```ts
import { vi } from 'vitest';

export function createChromeMock() {
  const store = new Map<string, unknown>();
  const messageListeners: Array<(message: unknown) => void> = [];

  return {
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (store.has(key)) result[key] = store.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) store.delete(key);
        }),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (message: unknown) => void) => {
          messageListeners.push(fn);
        }),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        for (const fn of messageListeners) fn(message);
      }),
    },
    action: {
      onClicked: {
        addListener: vi.fn((_fn: (tab: { id: number }) => void) => {}),
      },
    },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;
```

- [ ] **Step 2: Create the Vitest setup file**

`tests/setup.ts`:

```ts
import { createChromeMock } from './helpers/chrome-mock';

(globalThis as unknown as { chrome: unknown }).chrome = createChromeMock();
```

- [ ] **Step 3: Wire the setup file into Vitest config**

Modify `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 4: Write the failing test**

`tests/session-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { isSelectionActive, markSelectionActive, clearSelectionActive } from '../src/shared/session-state';

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = createChromeMock();
});

describe('session-state', () => {
  it('is inactive for a tab that was never marked', async () => {
    await expect(isSelectionActive(1)).resolves.toBe(false);
  });

  it('becomes active after marking, and inactive after clearing', async () => {
    await markSelectionActive(1);
    await expect(isSelectionActive(1)).resolves.toBe(true);

    await clearSelectionActive(1);
    await expect(isSelectionActive(1)).resolves.toBe(false);
  });

  it('tracks each tabId independently', async () => {
    await markSelectionActive(1);
    await expect(isSelectionActive(2)).resolves.toBe(false);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run tests/session-state.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/session-state'`

- [ ] **Step 6: Write minimal implementation**

`src/shared/session-state.ts`:

```ts
function keyFor(tabId: number): string {
  return `fontcia-active:${tabId}`;
}

export async function isSelectionActive(tabId: number): Promise<boolean> {
  const key = keyFor(tabId);
  const result = await chrome.storage.session.get(key);
  return Boolean(result[key]);
}

export async function markSelectionActive(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [keyFor(tabId)]: true });
}

export async function clearSelectionActive(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyFor(tabId));
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/session-state.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/chrome-mock.ts tests/setup.ts vitest.config.ts src/shared/session-state.ts tests/session-state.test.ts
git commit -m "feat: add per-tab selection-active flag backed by chrome.storage.session"
```

---

### Task 4: Background Service Worker Click Handler

**Files:**
- Create: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/service-worker.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { handleIconClick } from '../src/background/service-worker';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('handleIconClick', () => {
  it('arms a fresh tab: marks it active, injects the content script, sends ARM_SELECTION', async () => {
    await handleIconClick({ id: 7 } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content/overlay.js'],
    });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'ARM_SELECTION', tabId: 7 });

    const stored = await chromeMock.storage.session.get('fontcia-active:7');
    expect(stored['fontcia-active:7']).toBe(true);
  });

  it('toggles off an already-active tab instead of re-injecting', async () => {
    await chromeMock.storage.session.set({ 'fontcia-active:7': true });

    await handleIconClick({ id: 7 } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'DISMISS_SELECTION' });
  });

  it('does nothing for a tab with no id', async () => {
    await handleIconClick({} as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — `Cannot find module '../src/background/service-worker'`

- [ ] **Step 3: Write minimal implementation**

`src/background/service-worker.ts`:

```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';

const CONTENT_SCRIPT_FILE = 'content/overlay.js';

export async function handleIconClick(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

  const active = await isSelectionActive(tabId);

  if (active) {
    await chrome.tabs.sendMessage(tabId, { type: 'DISMISS_SELECTION' });
    return;
  }

  await markSelectionActive(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  await chrome.tabs.sendMessage(tabId, { type: 'ARM_SELECTION', tabId });
}

chrome.action.onClicked.addListener(handleIconClick);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: add icon-click handler with double-injection guard"
```

---

### Task 5: Content Overlay Creation, Crosshair, and Teardown

**Files:**
- Create: `src/content/theme.ts`
- Create: `src/content/overlay.ts`
- Test: `tests/overlay.test.ts`

- [ ] **Step 1: Create the theme token module**

`src/content/theme.ts`:

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
  color: var(--fontcia-success);
  font-size: 12px;
}
`;
```

- [ ] **Step 2: Write the failing test**

`tests/overlay.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { armSelectionMode, dismissSelection } from '../src/content/overlay';

afterEach(() => {
  dismissSelection();
  document.body.innerHTML = '';
});

describe('armSelectionMode / dismissSelection', () => {
  it('creates a shadow-DOM overlay host with a crosshair surface', () => {
    armSelectionMode(1);

    const host = document.getElementById('fontcia-overlay-host');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();

    const surface = host?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.style.cursor).toBe('crosshair');
  });

  it('tears down the overlay on dismiss', () => {
    armSelectionMode(1);
    dismissSelection();

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('tears down the overlay on Escape', () => {
    armSelectionMode(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('is safe to call dismissSelection when nothing is armed', () => {
    expect(() => dismissSelection()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — `Cannot find module '../src/content/overlay'`

- [ ] **Step 4: Write minimal implementation**

`src/content/overlay.ts`:

```ts
import { clearSelectionActive } from '../shared/session-state';
import { themeCss } from './theme';

let currentTabId: number | null = null;
let hostEl: HTMLDivElement | null = null;
let shadowSurface: HTMLDivElement | null = null;

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    dismissSelection();
  }
}

function createOverlay(): void {
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
  shadow.appendChild(shadowSurface);

  document.addEventListener('keydown', handleKeydown);
}

function teardownOverlay(): void {
  document.removeEventListener('keydown', handleKeydown);
  hostEl?.remove();
  hostEl = null;
  shadowSurface = null;
}

export function armSelectionMode(tabId: number): void {
  currentTabId = tabId;
  createOverlay();
}

export function dismissSelection(): void {
  if (currentTabId !== null) {
    void clearSelectionActive(currentTabId);
  }
  currentTabId = null;
  teardownOverlay();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/overlay.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 6: Commit**

```bash
git add src/content/theme.ts src/content/overlay.ts tests/overlay.test.ts
git commit -m "feat: create shadow-DOM selection overlay with crosshair and Esc teardown"
```

---

### Task 6: Locked-Selection Rendering (Box + Panel, Layout B)

**Files:**
- Create: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/locked-selection.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderLockedSelection } from '../src/content/locked-selection';

describe('renderLockedSelection', () => {
  it('renders a box positioned to the rect', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { box } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss);

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

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss);

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

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss);
    const closeBtn = panel.querySelector('.fontcia-panel-close') as HTMLElement;
    closeBtn.click();

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — `Cannot find module '../src/content/locked-selection'`

- [ ] **Step 3: Write minimal implementation**

`src/content/locked-selection.ts`:

```ts
import type { Rect } from '../shared/selection-box';

export interface LockedSelectionElements {
  box: HTMLDivElement;
  panel: HTMLDivElement;
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
): LockedSelectionElements {
  const box = document.createElement('div');
  box.className = 'fontcia-box';
  applyRect(box, rect);
  container.appendChild(box);

  const panel = document.createElement('div');
  panel.className = 'fontcia-panel';
  panel.style.left = `${rect.x}px`;
  panel.style.top = `${rect.y + rect.height + 8}px`;

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
  body.textContent = 'placeholder — goes here in step 2';
  panel.appendChild(body);

  container.appendChild(panel);

  return { box, panel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: render locked selection box + notch-connected placeholder panel (layout B)"
```

---

### Task 7: Drag Lifecycle Wiring

**Files:**
- Modify: `src/content/overlay.ts`
- Modify: `tests/overlay.test.ts`

- [ ] **Step 1: Write the failing tests (append to `tests/overlay.test.ts`)**

Add this `describe` block to `tests/overlay.test.ts`, inside the existing file (keep the earlier `describe` block as-is):

```ts
function dispatchMouse(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

describe('drag lifecycle', () => {
  it('draws a live draft box while dragging', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mousemove', 60, 40);

    const draft = surface.querySelector('.fontcia-draft-box') as HTMLElement;
    expect(draft).not.toBeNull();
    expect(draft.style.width).toBe('50px');
    expect(draft.style.height).toBe('30px');
  });

  it('locks a real drag into a box + panel and removes the draft box', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mousemove', 60, 40);
    dispatchMouse(surface, 'mouseup', 60, 40);

    expect(surface.querySelector('.fontcia-draft-box')).toBeNull();
    expect(surface.querySelector('.fontcia-box')).not.toBeNull();
    expect(surface.querySelector('.fontcia-panel')).not.toBeNull();
  });

  it('treats a sub-threshold drag as a no-op and stays armed', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 12, 10);

    expect(surface.querySelector('.fontcia-box')).toBeNull();
    expect(surface.querySelector('.fontcia-panel')).toBeNull();
    expect(document.getElementById('fontcia-overlay-host')).not.toBeNull();
  });

  it('dismisses the locked panel via its close button', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 60, 40);

    const closeBtn = surface.querySelector('.fontcia-panel-close') as HTMLElement;
    closeBtn.click();

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — draft/box/panel elements never appear (no drag handlers wired yet)

- [ ] **Step 3: Wire the drag lifecycle into the implementation**

Modify `src/content/overlay.ts` — add these imports at the top:

```ts
import { normalizeDragRect, isNoOpDrag, type Point } from '../shared/selection-box';
import { renderLockedSelection } from './locked-selection';
```

Add this module-level state alongside the existing `let` declarations:

```ts
let draftBox: HTMLDivElement | null = null;
let dragStart: Point | null = null;
let isDragging = false;
```

Add these handlers (place above `createOverlay`):

```ts
function handleMouseDown(event: MouseEvent): void {
  if (!shadowSurface) return;
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

  renderLockedSelection(shadowSurface, rect, dismissSelection);
}
```

In `createOverlay`, right after `shadow.appendChild(shadowSurface);`, add:

```ts
  shadowSurface.addEventListener('mousedown', handleMouseDown);
  shadowSurface.addEventListener('mousemove', handleMouseMove);
  shadowSurface.addEventListener('mouseup', handleMouseUp);
```

In `teardownOverlay`, add these resets alongside the existing ones:

```ts
  draftBox = null;
  dragStart = null;
  isDragging = false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/overlay.test.ts`
Expected: PASS — all tests (creation/teardown from Task 5 + drag lifecycle from this task) pass

- [ ] **Step 5: Commit**

```bash
git add src/content/overlay.ts tests/overlay.test.ts
git commit -m "feat: wire drag lifecycle into overlay with no-op threshold and locked rendering"
```

---

### Task 8: Runtime Messaging + Build Verification

**Files:**
- Modify: `src/content/overlay.ts`
- Test: `tests/overlay-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

`tests/overlay-integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(async () => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  // Re-import fresh each test so the module's onMessage listener registers against this test's mock.
  await import('../src/content/overlay');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('runtime message wiring', () => {
  it('arms selection mode on an ARM_SELECTION message', async () => {
    await chrome.tabs.sendMessage(7, { type: 'ARM_SELECTION', tabId: 7 });

    expect(document.getElementById('fontcia-overlay-host')).not.toBeNull();
  });

  it('dismisses on a DISMISS_SELECTION message and clears the storage flag', async () => {
    await chromeMock.storage.session.set({ 'fontcia-active:7': true });

    await chrome.tabs.sendMessage(7, { type: 'ARM_SELECTION', tabId: 7 });
    await chrome.tabs.sendMessage(7, { type: 'DISMISS_SELECTION' });

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
    const stored = await chromeMock.storage.session.get('fontcia-active:7');
    expect(stored['fontcia-active:7']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlay-integration.test.ts`
Expected: FAIL — sending `ARM_SELECTION`/`DISMISS_SELECTION` messages has no effect (no listener registered yet)

- [ ] **Step 3: Add the runtime message listener**

Modify `src/content/overlay.ts` — append at the end of the file:

```ts
chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number }) => {
  if (message?.type === 'ARM_SELECTION' && typeof message.tabId === 'number') {
    armSelectionMode(message.tabId);
  } else if (message?.type === 'DISMISS_SELECTION') {
    dismissSelection();
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/overlay-integration.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: `tsc --noEmit` produces no errors; all test files pass (selection-box, session-state, service-worker, overlay, locked-selection, overlay-integration).

- [ ] **Step 6: Verify the production build**

Run: `npm run build`
Expected: creates `dist/background/service-worker.js`, `dist/content/overlay.js`, and `dist/manifest.json` with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/content/overlay.ts tests/overlay-integration.test.ts
git commit -m "feat: wire ARM_SELECTION/DISMISS_SELECTION runtime messages into the content script"
```

---

### Task 9: Manual E2E Verification (Load Unpacked in Chrome)

This is the manual/E2E pass called out in the spec — not automatable without a full browser-driving setup, which is out of scope for the shell. Load `dist/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked → select the `dist/` folder produced by `npm run build`) and verify each item below.

**Files:**
- None (manual verification only; no code changes expected unless a check fails)

- [ ] **Step 1: Basic lifecycle**
  - Click the extension icon on any regular webpage (not `chrome://` — content scripts can't run there).
  - Confirm the cursor becomes a crosshair.
  - Drag a box over some text; confirm it locks on release and the panel appears directly under the box with the notch and dashed border (layout B).

- [ ] **Step 2: Escape at each stage**
  - Click the icon (armed, no box drawn yet), press `Esc` — confirm the crosshair/overlay disappears.
  - Click the icon, start dragging, press `Esc` mid-drag — confirm it cancels cleanly.
  - Lock a box, press `Esc` — confirm the box and panel disappear.

- [ ] **Step 3: Toggle-off via icon (double-injection guard)**
  - Click the icon to arm, then click the icon again before drawing — confirm it dismisses (does not create a second overlay).
  - Click the icon, lock a box (so the panel is showing), then click the icon again — confirm this also dismisses the existing panel rather than injecting a second overlay on top of it. This is the specific case the plan's storage-flag correction targets — verify carefully.

- [ ] **Step 4: Panel close button**
  - Lock a box, click the panel's `×` — confirm it dismisses the same way `Esc` does.

- [ ] **Step 5: One-shot re-arm**
  - After any dismiss or lock, confirm the extension is fully off — clicking anywhere on the page does nothing until the icon is clicked again.

- [ ] **Step 6: Theme token contrast (manual CSS flip, no toggle UI yet)**
  - In DevTools, temporarily add the `theme-light` class to the `.fontcia-surface` element and confirm the box/panel/text still read clearly against both a very light and very dark page background (the tokens must stay high-contrast regardless of host page color, per the doc's design-token requirement).

- [ ] **Step 7: SPA navigation edge case (flagged in spec, not pre-solved)**
  - On a site with client-side routing (e.g., YouTube), arm selection mode and trigger a route change mid-selection (mid-drag or locked) — e.g., let a video autoplay to the next one, or navigate via the site's internal links.
  - Confirm the shadow-DOM overlay either tears down cleanly or does not end up orphaned/detached against stale content. If it does end up orphaned, note the exact repro (which site, which stage — armed/dragging/locked) — this becomes a scoped follow-up fix, not a blocker for this shell to be considered done, per the spec's explicit "flagged for testing, not solved in this phase."

- [ ] **Step 8: Record results**
  - If all checks in Steps 1–6 pass and Step 7 is at minimum documented (pass or repro noted), the extension shell is complete. No commit needed for this task unless a fix was required, in which case follow the standard failing-test → fix → passing-test → commit cycle for that specific fix.

---

## Self-Review Notes

- **Spec coverage:** icon click + double-injection guard → Task 4/8; crosshair + shadow DOM → Task 5; drag-to-lock + no-op threshold → Task 2/7; placeholder panel layout B → Task 6; Esc/×/toggle-off unified dismiss → Tasks 5/7/8; `chrome.storage.session` persistence → Task 3; theme tokens wired, dark default, no toggle UI → Task 5 (`theme.ts`); SPA-navigation edge case flagged for testing → Task 9, Step 7. All spec sections are covered.
- **Storage-flag semantics correction:** documented at the top of this plan and re-verified explicitly in Task 9, Step 3, since it's the one place this plan diverges from the literal spec wording.
- **Type/name consistency check:** `Rect`/`Point` from `selection-box.ts` are imported with matching names in `locked-selection.ts` and `overlay.ts`; `armSelectionMode`/`dismissSelection` names are consistent from Task 5 through Task 8; message shape `{ type, tabId }` matches between `service-worker.ts` (Task 4) and `overlay.ts`'s listener (Task 8).
