# Account Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/login/` with a single, tab-based `src/account/` dashboard (Account, Saved Fonts, History, Settings), and wire up a real, persisted, live-reactive dark/light theme toggle across both the new page and the existing scan-dialogue overlay.

**Architecture:** One extension page (`account.html`/`account.ts`) with client-side tab switching between four pure, directly-testable render functions, mirroring the `scan-dialogue.ts`/`enrollment.ts` pattern rather than `login.ts`'s self-executing-on-import style. Theme is a plain `chrome.storage.local` preference read/written directly by both the content script and the account page (no message-passing, unlike auth tokens) — colors live once in a new shared module, consumed by both the existing floating panel and the new full-page dashboard.

**Tech Stack:** TypeScript, Express, Prisma/Postgres, Chrome Extension Manifest V3, Vitest + jsdom (client) / Vitest + supertest + real Postgres (server) — all existing conventions, no new dependencies.

---

## File Structure

```
server/src/routes/scans.ts               — gains GET / (requireAuth, scoped, capped, newest-first)
server/tests/scans.test.ts               — new GET / tests

src/shared/theme-colors.ts               — new: DARK_THEME_VARS / LIGHT_THEME_VARS CSS bodies
src/shared/theme-storage.ts              — new: Theme type, THEME_STORAGE_KEY, getStoredTheme/setStoredTheme
tests/theme-storage.test.ts              — new
src/content/theme.ts                     — modified: hex values replaced by theme-colors.ts interpolation
src/content/overlay.ts                   — modified: applies + live-updates the stored theme
tests/overlay.test.ts                    — new theme-application/live-update tests
src/content/locked-selection.ts          — modified: handleLoginPrompt's URL string only
tests/locked-selection.test.ts           — one existing URL assertion updated

src/shared/api-messages.ts               — gains GET_SAVED_FONTS, GET_SCANS
src/background/api-client.ts             — gains getSavedFonts(), getScans()
tests/api-client.test.ts                 — new tests for the above
src/background/service-worker.ts         — two new dispatch cases
tests/service-worker.test.ts             — new tests for the above

src/account/account.html                 — new: thin shell, tab nav + empty view container
src/account/account-theme.ts             — new: full-page dashboard CSS, no test (pure CSS, like theme.ts)
src/account/account-view.ts              — new: login/signup + logged-in email/logout (ports login.ts)
src/account/saved-fonts-view.ts          — new: list + delete
src/account/history-view.ts              — new: list, read-only
src/account/settings-view.ts             — new: theme toggle + read-only email
src/account/account.ts                   — new: tab orchestration + staleness guard
tests/account-view.test.ts               — new (replaces tests/login.test.ts)
tests/saved-fonts-view.test.ts           — new
tests/history-view.test.ts               — new
tests/settings-view.test.ts              — new
tests/account.test.ts                    — new

src/login/                               — deleted (login.html, login.ts)
tests/login.test.ts                      — deleted

manifest.json                            — web_accessible_resources path updated
esbuild.config.mjs                       — login entry point/outdir/copy step → account
```

---

### Task 1: `GET /scans`

**Files:**
- Modify: `server/src/routes/scans.ts`
- Test: `server/tests/scans.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/scans.test.ts`, after the existing `describe('POST /scans', ...)` block:

```ts
describe('GET /scans', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/scans');
    expect(res.status).toBe(401);
  });

  it("lists the current user's own scans, newest first, including both matches and no-matches", async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken } = signupRes.body;

    await request(app)
      .post('/scans')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'match', fontName: 'Inter', confidence: 92 });
    await request(app).post('/scans').set('Authorization', `Bearer ${accessToken}`).send({ status: 'no-match' });

    const res = await request(app).get('/scans').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.scans).toHaveLength(2);
    expect(res.body.scans[0].status).toBe('no-match');
    expect(res.body.scans[1].status).toBe('match');
    expect(res.body.scans[1].fontName).toBe('Inter');
  });

  it("does not include another user's scans", async () => {
    const userAToken = (
      await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'password123' })
    ).body.accessToken;
    const userBToken = (
      await request(app).post('/auth/signup').send({ email: 'b@example.com', password: 'password123' })
    ).body.accessToken;

    await request(app)
      .post('/scans')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ status: 'match', fontName: 'Inter', confidence: 92 });

    const res = await request(app).get('/scans').set('Authorization', `Bearer ${userBToken}`);

    expect(res.body.scans).toEqual([]);
  });

  it('does not include anonymous scans', async () => {
    const token = (await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'password123' }))
      .body.accessToken;
    await request(app).post('/scans').send({ status: 'match', fontName: 'Inter', confidence: 92 });

    const res = await request(app).get('/scans').set('Authorization', `Bearer ${token}`);

    expect(res.body.scans).toEqual([]);
  });

  it('caps results at the history limit', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken, user } = signupRes.body;

    await prisma.scan.createMany({
      data: Array.from({ length: 55 }, () => ({ userId: user.id, status: 'no-match' })),
    });

    const res = await request(app).get('/scans').set('Authorization', `Bearer ${accessToken}`);

    expect(res.body.scans).toHaveLength(50);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run tests/scans.test.ts`
Expected: FAIL — `GET /scans` doesn't exist yet (404s).

- [ ] **Step 3: Update `server/src/routes/scans.ts`**

Change from:
```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';

export const scansRouter = Router();

scansRouter.post('/', optionalAuth, async (req, res, next) => {
```
to:
```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { requireAuth } from '../middleware/require-auth';
import { ApiError } from '../middleware/error-handler';

export const scansRouter = Router();

// v1 cap, not true pagination — same treatment as this project's other
// list-endpoint size limits (e.g. TOP_K in font-matches.ts).
const SCAN_HISTORY_LIMIT = 50;

scansRouter.post('/', optionalAuth, async (req, res, next) => {
```

Add at the end of the file, after the existing `POST /` handler's closing `});`:
```ts

scansRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const scans = await prisma.scan.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: SCAN_HISTORY_LIMIT,
    });
    res.status(200).json({ scans });
  } catch (error) {
    next(error);
  }
});
```

`requireAuth` is applied per-route (not router-wide via `.use()`) since `POST /` keeps its existing `optionalAuth` — matching `font-matches.ts`'s existing precedent for a router with mixed auth requirements across its routes.

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run tests/scans.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full test suite**

Run (from `server/`): `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/scans.ts server/tests/scans.test.ts
git commit -m "feat: add GET /scans for the account dashboard's history view"
```

---

### Task 2: Theme Colors + Theme Storage

**Files:**
- Create: `src/shared/theme-colors.ts`, `src/shared/theme-storage.ts`
- Modify: `src/content/theme.ts`
- Test: `tests/theme-storage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/theme-storage.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { getStoredTheme, setStoredTheme, THEME_STORAGE_KEY } from '../src/shared/theme-storage';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('getStoredTheme', () => {
  it('defaults to dark when nothing is stored', async () => {
    await expect(getStoredTheme()).resolves.toBe('dark');
  });

  it('returns the stored value when it is light', async () => {
    await chromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'light' });
    await expect(getStoredTheme()).resolves.toBe('light');
  });

  it('falls back to dark for any unrecognized stored value', async () => {
    await chromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'not-a-real-theme' });
    await expect(getStoredTheme()).resolves.toBe('dark');
  });
});

describe('setStoredTheme', () => {
  it('persists the theme so a later getStoredTheme sees it', async () => {
    await setStoredTheme('light');
    await expect(getStoredTheme()).resolves.toBe('light');
  });

  it('round-trips back to dark', async () => {
    await setStoredTheme('light');
    await setStoredTheme('dark');
    await expect(getStoredTheme()).resolves.toBe('dark');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/theme-storage.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/theme-storage'`.

- [ ] **Step 3: Create `src/shared/theme-colors.ts`**

```ts
export const DARK_THEME_VARS = `
  --fontcia-bg: #14171A;
  --fontcia-surface: #1F242B;
  --fontcia-text: #E8E6E1;
  --fontcia-accent: #FF6A3D;
  --fontcia-success: #3FA796;
  --fontcia-border: #2A2F36;
`;

export const LIGHT_THEME_VARS = `
  --fontcia-bg: #FFFFFF;
  --fontcia-surface: #F4F4F5;
  --fontcia-text: #18181B;
  --fontcia-accent: #FF6A3D;
  --fontcia-success: #16A34A;
  --fontcia-border: #E5E5E7;
`;
```

- [ ] **Step 4: Create `src/shared/theme-storage.ts`**

```ts
export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'fontcia-theme';

export async function getStoredTheme(): Promise<Theme> {
  const result = await chrome.storage.local.get(THEME_STORAGE_KEY);
  return result[THEME_STORAGE_KEY] === 'light' ? 'light' : 'dark';
}

export async function setStoredTheme(theme: Theme): Promise<void> {
  await chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme });
}
```

- [ ] **Step 5: Update `src/content/theme.ts` to consume the shared colors**

Change from:
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
```
to:
```ts
import { DARK_THEME_VARS, LIGHT_THEME_VARS } from '../shared/theme-colors';

export const themeCss = `
.fontcia-surface {
  ${DARK_THEME_VARS}
  position: fixed;
  inset: 0;
  cursor: crosshair;
}

.fontcia-surface.theme-light {
  ${LIGHT_THEME_VARS}
}
```

Everything else in the file (from `.fontcia-draft-box` onward) is unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/theme-storage.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 7: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck; all existing tests still pass — `theme.ts`'s CSS output is byte-for-byte identical to before (only how the hex values are assembled changed, not their values or the selectors around them), so no existing test that touches rendered panel CSS should break.

- [ ] **Step 8: Commit**

```bash
git add src/shared/theme-colors.ts src/shared/theme-storage.ts src/content/theme.ts tests/theme-storage.test.ts
git commit -m "feat: add shared theme colors and a chrome.storage.local-backed theme preference"
```

---

### Task 3: `overlay.ts` — Apply and Live-Update the Theme

**Files:**
- Modify: `src/content/overlay.ts`
- Test: `tests/overlay.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/overlay.test.ts`. First, update the import block from:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { armSelectionMode, dismissSelection } from '../src/content/overlay';
import { isSelectionActive, markSelectionActive } from '../src/shared/session-state';
```
to:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { armSelectionMode, dismissSelection } from '../src/content/overlay';
import { isSelectionActive, markSelectionActive } from '../src/shared/session-state';
import { moduleLoadChromeMock } from './setup';
import { THEME_STORAGE_KEY } from '../src/shared/theme-storage';
```

Add this new `describe` block at the end of the file (after the existing `describe('drag lifecycle', ...)` block):

```ts
describe('theme application', () => {
  afterEach(async () => {
    await moduleLoadChromeMock.storage.local.remove(THEME_STORAGE_KEY);
  });

  it('applies no theme-light class when nothing is stored (defaults to dark)', async () => {
    armSelectionMode(1);
    await Promise.resolve();
    await Promise.resolve();

    const surface = document
      .querySelector('#fontcia-overlay-host')
      ?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;
    expect(surface.classList.contains('theme-light')).toBe(false);
  });

  it('applies the theme-light class when light is stored', async () => {
    await moduleLoadChromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'light' });

    armSelectionMode(1);
    await Promise.resolve();
    await Promise.resolve();

    const surface = document
      .querySelector('#fontcia-overlay-host')
      ?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;
    expect(surface.classList.contains('theme-light')).toBe(true);
  });

  it('live-updates an already-open panel when the theme changes via storage.onChanged', async () => {
    armSelectionMode(1);
    await Promise.resolve();
    await Promise.resolve();
    const surface = document
      .querySelector('#fontcia-overlay-host')
      ?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;
    expect(surface.classList.contains('theme-light')).toBe(false);

    await moduleLoadChromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'light' });
    const changeListener = moduleLoadChromeMock.storage.onChanged.addListener.mock.calls[0][0];
    changeListener({ [THEME_STORAGE_KEY]: { newValue: 'light' } }, 'local');
    await Promise.resolve();
    await Promise.resolve();

    expect(surface.classList.contains('theme-light')).toBe(true);
  });

  it('does not react to an unrelated storage key changing', async () => {
    armSelectionMode(1);
    await Promise.resolve();
    await Promise.resolve();
    const surface = document
      .querySelector('#fontcia-overlay-host')
      ?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;

    const changeListener = moduleLoadChromeMock.storage.onChanged.addListener.mock.calls[0][0];
    changeListener({ 'fontcia-auth': { newValue: {} } }, 'local');
    await Promise.resolve();
    await Promise.resolve();

    expect(surface.classList.contains('theme-light')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/overlay.test.ts`
Expected: FAIL — no theme application exists yet, and `moduleLoadChromeMock.storage.onChanged.addListener` has never been called by `overlay.ts` (`mock.calls[0]` is undefined).

- [ ] **Step 3: Update `src/content/overlay.ts`**

Change the import block from:
```ts
import { clearSelectionActive, markSelectionActive } from '../shared/session-state';
import { normalizeDragRect, isNoOpDrag, type Point } from '../shared/selection-box';
import { renderLockedSelection } from './locked-selection';
import { themeCss } from './theme';
```
to:
```ts
import { clearSelectionActive, markSelectionActive } from '../shared/session-state';
import { normalizeDragRect, isNoOpDrag, type Point } from '../shared/selection-box';
import { renderLockedSelection } from './locked-selection';
import { themeCss } from './theme';
import { getStoredTheme, THEME_STORAGE_KEY } from '../shared/theme-storage';
```

Change `createOverlay` from:
```ts
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
```
to:
```ts
// A separate, fire-and-forget async step rather than making createOverlay itself
// async: the crosshair cursor and drag handling must be available immediately with
// no user-visible delay, and neither depends on which theme is applied — only the
// colors do. This one extra chrome.storage.local round trip resolves well before a
// real user finishes their drag gesture.
async function applyStoredTheme(): Promise<void> {
  if (!shadowSurface) return;
  const theme = await getStoredTheme();
  if (!shadowSurface) return; // could have been torn down while this awaited
  shadowSurface.classList.toggle('theme-light', theme === 'light');
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
  void applyStoredTheme();

  shadowSurface.addEventListener('mousedown', handleMouseDown);
  shadowSurface.addEventListener('mousemove', handleMouseMove);
  shadowSurface.addEventListener('mouseup', handleMouseUp);

  document.addEventListener('keydown', handleKeydown);
}
```

Change the module-load guard block at the bottom of the file from:
```ts
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
to:
```ts
if (!window.__fontciaOverlayInjected) {
  window.__fontciaOverlayInjected = true;

  chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number }) => {
    if (message?.type === 'ARM_SELECTION' && typeof message.tabId === 'number') {
      armSelectionMode(message.tabId);
    } else if (message?.type === 'DISMISS_SELECTION') {
      dismissSelection();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && THEME_STORAGE_KEY in changes) {
      void applyStoredTheme();
    }
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/overlay.test.ts`
Expected: PASS — all tests in the file pass, including every pre-existing test.

- [ ] **Step 5: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/content/overlay.ts tests/overlay.test.ts
git commit -m "feat: apply and live-update the stored theme on the scan-dialogue overlay"
```

---

### Task 4: `locked-selection.ts` — Update the Login URL

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts`

- [ ] **Step 1: Update the failing test**

In `tests/locked-selection.test.ts`, change:
```ts
    expect(windowOpenSpy).toHaveBeenCalledWith('chrome-extension://fake-extension-id/login/login.html', '_blank');
```
to:
```ts
    expect(windowOpenSpy).toHaveBeenCalledWith('chrome-extension://fake-extension-id/account/account.html', '_blank');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — `handleLoginPrompt` still opens the old URL.

- [ ] **Step 3: Update `src/content/locked-selection.ts`**

Change:
```ts
  function handleLoginPrompt(): void {
    window.open(chrome.runtime.getURL('login/login.html'), '_blank');
  }
```
to:
```ts
  function handleLoginPrompt(): void {
    window.open(chrome.runtime.getURL('account/account.html'), '_blank');
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: point the login prompt at the new account dashboard"
```

---

### Task 5: Client Shared Types

**Files:**
- Modify: `src/shared/api-messages.ts`

No test in this task — pure type declarations, verified by `npm run typecheck`.

- [ ] **Step 1: Update `src/shared/api-messages.ts`**

Change from:
```ts
  | { type: 'GET_PENDING_SUBMISSIONS' }
  | { type: 'CONFIRM_FONT_SUBMISSION'; id: string; sourceUrl: string | null }
  | { type: 'RESOLVE_FONT_NAME'; fontFamilyStack: string };
```
to:
```ts
  | { type: 'GET_PENDING_SUBMISSIONS' }
  | { type: 'CONFIRM_FONT_SUBMISSION'; id: string; sourceUrl: string | null }
  | { type: 'RESOLVE_FONT_NAME'; fontFamilyStack: string }
  | { type: 'GET_SAVED_FONTS' }
  | { type: 'GET_SCANS' };
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no new errors (both are brand-new message types with no existing call sites yet).

- [ ] **Step 3: Commit**

```bash
git add src/shared/api-messages.ts
git commit -m "feat: add GET_SAVED_FONTS and GET_SCANS message types"
```

---

### Task 6: `api-client.ts`

**Files:**
- Modify: `src/background/api-client.ts`
- Test: `tests/api-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api-client.test.ts`'s import block:
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
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
  getSavedFonts,
  getScans,
} from '../src/background/api-client';
```

Add these new `describe` blocks at the end of the file:
```ts
describe('getSavedFonts', () => {
  it('fetches and unwraps the savedFonts array', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        savedFonts: [
          { id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );

    const result = await getSavedFonts();

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/saved-fonts');
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await getSavedFonts();

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getScans', () => {
  it('fetches and unwraps the scans array', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        scans: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );

    const result = await getScans();

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/scans');
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await getScans();

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api-client.test.ts`
Expected: FAIL — `getSavedFonts`/`getScans` aren't exported.

- [ ] **Step 3: Add the two functions to `src/background/api-client.ts`**

Add at the end of the file, after `resolveFontName`:
```ts

export interface SavedFontRecord {
  id: string;
  fontName: string;
  confidence: number;
  sources: ScanSource[];
  savedAt: string;
}

export async function getSavedFonts(): Promise<ApiResponse<SavedFontRecord[]>> {
  const result = await apiFetch<{ savedFonts: SavedFontRecord[] }>('/saved-fonts', {
    method: 'GET',
    auth: 'required',
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.savedFonts };
}

export interface ScanRecord {
  id: string;
  status: 'match' | 'no-match';
  fontName: string | null;
  confidence: number | null;
  createdAt: string;
}

export async function getScans(): Promise<ApiResponse<ScanRecord[]>> {
  const result = await apiFetch<{ scans: ScanRecord[] }>('/scans', { method: 'GET', auth: 'required' });
  if (!result.ok) return result;
  return { ok: true, data: result.data.scans };
}
```

(`ScanSource` is already imported at the top of this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api-client.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/background/api-client.ts tests/api-client.test.ts
git commit -m "feat: add getSavedFonts and getScans to api-client"
```

---

### Task 7: `service-worker.ts`

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/service-worker.test.ts`, inside the `describe('handleApiMessage', ...)` block, after the existing `RESOLVE_FONT_NAME` dispatch test and before the `'returns an error response for an unrecognized message type'` test:

```ts
  it('dispatches GET_SAVED_FONTS to the api-client getSavedFonts function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(),
      getPendingSubmissions: vi.fn(),
      confirmFontSubmission: vi.fn(),
      submitFont: vi.fn(),
      resolveFontName: vi.fn(),
      getSavedFonts: vi.fn(async () => ({
        ok: true,
        data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
      })),
      getScans: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { getSavedFonts } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'GET_SAVED_FONTS' });

    expect(getSavedFonts).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
    });
  });

  it('dispatches GET_SCANS to the api-client getScans function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(),
      getPendingSubmissions: vi.fn(),
      confirmFontSubmission: vi.fn(),
      submitFont: vi.fn(),
      resolveFontName: vi.fn(),
      getSavedFonts: vi.fn(),
      getScans: vi.fn(async () => ({
        ok: true,
        data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
      })),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { getScans } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'GET_SCANS' });

    expect(getScans).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — both message types fall to the `default` case.

- [ ] **Step 3: Update `src/background/service-worker.ts`**

Change the import block from:
```ts
import {
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
} from './api-client';
```
to:
```ts
import {
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
  getSavedFonts,
  getScans,
} from './api-client';
```

Change `handleApiMessage`'s switch from:
```ts
      case 'RESOLVE_FONT_NAME':
        return await resolveFontName(message.fontFamilyStack);
      default:
```
to:
```ts
      case 'RESOLVE_FONT_NAME':
        return await resolveFontName(message.fontFamilyStack);
      case 'GET_SAVED_FONTS':
        return await getSavedFonts();
      case 'GET_SCANS':
        return await getScans();
      default:
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: dispatch GET_SAVED_FONTS and GET_SCANS"
```

---

### Task 8: `account.html` + `account-theme.ts`

**Files:**
- Create: `src/account/account.html`, `src/account/account-theme.ts`

No test in this task — a static HTML shell and a pure CSS-string module, matching how `theme.ts`'s original CSS addition had no dedicated test. Verified indirectly by every later task's tests, which render into elements this file's styles target.

- [ ] **Step 1: Create `src/account/account.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>fontCIA — Account</title>
  </head>
  <body>
    <nav id="tabNav">
      <button id="tabAccount" type="button" class="fontcia-tab-btn">Account</button>
      <button id="tabSavedFonts" type="button" class="fontcia-tab-btn">Saved Fonts</button>
      <button id="tabHistory" type="button" class="fontcia-tab-btn">History</button>
      <button id="tabSettings" type="button" class="fontcia-tab-btn">Settings</button>
    </nav>
    <main id="viewContainer"></main>
    <script src="account.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/account/account-theme.ts`**

```ts
import { DARK_THEME_VARS, LIGHT_THEME_VARS } from '../shared/theme-colors';

export const accountCss = `
:root {
  ${DARK_THEME_VARS}
}

:root.theme-light {
  ${LIGHT_THEME_VARS}
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--fontcia-bg);
  color: var(--fontcia-text);
  min-width: 360px;
}

#tabNav {
  display: flex;
  border-bottom: 1px solid var(--fontcia-border);
}

.fontcia-tab-btn {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--fontcia-text);
  padding: 12px 8px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.fontcia-tab-btn.tab-active {
  border-bottom-color: var(--fontcia-accent);
  font-weight: 600;
}

#viewContainer {
  padding: 20px;
  max-width: 480px;
}

.fontcia-btn {
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
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

.fontcia-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid var(--fontcia-border);
  border-radius: 6px;
  background: var(--fontcia-surface);
  color: var(--fontcia-text);
  font-size: 13px;
  font-family: inherit;
}

.fontcia-sources {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}

.fontcia-sources a {
  color: var(--fontcia-text);
  font-size: 12px;
  text-decoration: none;
}

.fontcia-sources a:hover {
  text-decoration: underline;
}

.fontcia-list-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 0;
  border-bottom: 1px solid var(--fontcia-border);
}

.fontcia-list-row:last-child {
  border-bottom: none;
}

.fontcia-list-row-title {
  font-size: 14px;
  font-weight: 600;
}

.fontcia-list-row-meta {
  font-size: 12px;
  color: var(--fontcia-text);
  opacity: 0.8;
}

.fontcia-error-message {
  color: var(--fontcia-accent);
  font-size: 12px;
}

.fontcia-empty-message {
  font-size: 13px;
  opacity: 0.8;
  margin-bottom: 12px;
}
`;
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean (nothing imports `account-theme.ts` yet, so this just confirms the file itself has no syntax errors).

- [ ] **Step 4: Commit**

```bash
git add src/account/account.html src/account/account-theme.ts
git commit -m "feat: add the account dashboard's HTML shell and stylesheet"
```

---

### Task 9: `account-view.ts`

**Files:**
- Create: `src/account/account-view.ts`
- Test: `tests/account-view.test.ts`

This ports `src/login/login.ts`'s exact behavior into the `render*View(container, isStale)` pattern — same messages sent, same error handling, same logged-in/form-view split, just DOM-constructed into a container instead of showing/hiding a static HTML fixture.

- [ ] **Step 1: Write the failing tests**

Create `tests/account-view.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderAccountView } from '../src/account/account-view';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('renderAccountView', () => {
  it('shows the login form when GET_AUTH_STATE reports logged out', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: false } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(form?.hidden).toBe(false);
  });

  it('shows the logged-in email when GET_AUTH_STATE reports logged in', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    expect(container.textContent).toContain('Logged in as a@example.com');
  });

  it('submits a LOGIN message by default and shows the logged-in view on success', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    (container.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'password123';
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOGIN',
      email: 'a@example.com',
      password: 'password123',
    });
    expect(container.textContent).toContain('Logged in as a@example.com');
  });

  it('submits a SIGNUP message after switching to sign-up mode', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    const signupBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Sign up',
    ) as HTMLButtonElement;
    signupBtn.click();
    (container.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'password123';
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SIGNUP',
      email: 'a@example.com',
      password: 'password123',
    });
  });

  it('shows the error message text on a failed login', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: false, error: 'Invalid email or password' });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    (container.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'wrongpassword';
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorEl = container.querySelector('.fontcia-error-message') as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('Invalid email or password');
  });

  it('sends LOGOUT and returns to the form view when Log out is clicked', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } })
      .mockResolvedValueOnce({ ok: true, data: null });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    const logoutBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Log out',
    ) as HTMLButtonElement;
    logoutBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOGOUT' });
    expect((container.querySelector('form') as HTMLFormElement).hidden).toBe(false);
  });

  it('falls back to the form view instead of hanging when GET_AUTH_STATE rejects on load', async () => {
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error('service worker unreachable'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    expect((container.querySelector('form') as HTMLFormElement).hidden).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('does not update the DOM if isStale reports true after the initial auth check', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } });

    const container = document.createElement('div');
    await renderAccountView(container, () => true);

    expect(container.textContent).not.toContain('Logged in as a@example.com');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/account-view.test.ts`
Expected: FAIL — `Cannot find module '../src/account/account-view'`.

- [ ] **Step 3: Create `src/account/account-view.ts`**

```ts
import type { ApiMessage, ApiResponse } from '../shared/api-messages';

type Mode = 'login' | 'signup';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderAccountView(container: HTMLElement, isStale: () => boolean): Promise<void> {
  container.replaceChildren();
  let mode: Mode = 'login';

  const loggedInView = document.createElement('div');
  loggedInView.hidden = true;
  const loggedInMessage = document.createElement('p');
  loggedInView.appendChild(loggedInMessage);
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'fontcia-btn fontcia-btn-secondary';
  logoutBtn.textContent = 'Log out';
  loggedInView.appendChild(logoutBtn);

  const formView = document.createElement('div');

  const modeRow = document.createElement('div');
  const modeLoginBtn = document.createElement('button');
  modeLoginBtn.type = 'button';
  modeLoginBtn.className = 'fontcia-btn fontcia-btn-secondary';
  modeLoginBtn.textContent = 'Log in';
  const modeSignupBtn = document.createElement('button');
  modeSignupBtn.type = 'button';
  modeSignupBtn.className = 'fontcia-btn fontcia-btn-secondary';
  modeSignupBtn.textContent = 'Sign up';
  modeRow.appendChild(modeLoginBtn);
  modeRow.appendChild(modeSignupBtn);
  formView.appendChild(modeRow);

  const form = document.createElement('form');
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.className = 'fontcia-input';
  emailInput.placeholder = 'Email';
  emailInput.required = true;
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.className = 'fontcia-input';
  passwordInput.placeholder = 'Password';
  passwordInput.required = true;
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'fontcia-btn fontcia-btn-primary';
  submitBtn.textContent = 'Log in';
  form.appendChild(emailInput);
  form.appendChild(passwordInput);
  form.appendChild(submitBtn);
  formView.appendChild(form);

  const errorMessage = document.createElement('p');
  errorMessage.className = 'fontcia-error-message';
  errorMessage.hidden = true;
  formView.appendChild(errorMessage);

  container.appendChild(loggedInView);
  container.appendChild(formView);

  function setMode(newMode: Mode): void {
    mode = newMode;
    submitBtn.textContent = mode === 'login' ? 'Log in' : 'Sign up';
  }

  function showError(message: string): void {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
  }

  function showLoggedInView(email: string): void {
    formView.hidden = true;
    loggedInView.hidden = false;
    loggedInMessage.textContent = `Logged in as ${email}`;
  }

  function showFormView(): void {
    loggedInView.hidden = true;
    formView.hidden = false;
  }

  modeLoginBtn.addEventListener('click', () => setMode('login'));
  modeSignupBtn.addEventListener('click', () => setMode('signup'));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = emailInput.value;
    const password = passwordInput.value;

    const message: ApiMessage =
      mode === 'login' ? { type: 'LOGIN', email, password } : { type: 'SIGNUP', email, password };

    sendMessage<{ user: { id: string; email: string } }>(message)
      .then((response) => {
        if (isStale()) return;
        if (response.ok) {
          errorMessage.hidden = true;
          showLoggedInView(response.data.user.email);
        } else {
          showError(response.error);
        }
      })
      .catch((error: unknown) => {
        if (isStale()) return;
        console.error('fontCIA: login request failed', error);
        showError('Something went wrong. Please try again.');
      });
  });

  logoutBtn.addEventListener('click', () => {
    sendMessage<null>({ type: 'LOGOUT' })
      .then(() => {
        if (isStale()) return;
        showFormView();
      })
      .catch((error: unknown) => console.error('fontCIA: logout failed', error));
  });

  try {
    const authState = await sendMessage<{ loggedIn: boolean; email?: string }>({ type: 'GET_AUTH_STATE' });
    if (isStale()) return;
    if (authState.ok && authState.data.loggedIn && authState.data.email) {
      showLoggedInView(authState.data.email);
    }
  } catch (error) {
    if (isStale()) return;
    console.error('fontCIA: failed to check auth state on load', error);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/account-view.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/account/account-view.ts tests/account-view.test.ts
git commit -m "feat: add the account dashboard's login/signup view"
```

---

### Task 10: `saved-fonts-view.ts`

**Files:**
- Create: `src/account/saved-fonts-view.ts`
- Test: `tests/saved-fonts-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/saved-fonts-view.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderSavedFontsView } from '../src/account/saved-fonts-view';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('renderSavedFontsView', () => {
  it('shows a login prompt and calls onNavigateToAccount when logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });
    const onNavigateToAccount = vi.fn();

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, onNavigateToAccount);

    expect(container.textContent).toContain('Log in to see your saved fonts.');
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onNavigateToAccount).toHaveBeenCalledOnce();
  });

  it('shows an empty message when logged in with no saved fonts', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    expect(container.textContent).toContain("You haven't saved any fonts yet.");
  });

  it('renders each saved font with its confidence, sources, and a delete button', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') {
        return {
          ok: true,
          data: [
            {
              id: 'font-1',
              fontName: 'Inter',
              confidence: 92,
              sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
              savedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    expect(container.querySelector('.fontcia-list-row-title')?.textContent).toBe('Inter');
    expect(container.textContent).toContain('92% confidence');
    expect(container.querySelector('.fontcia-sources a')?.textContent).toBe('Google Fonts');
    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove');
    expect(deleteBtn).not.toBeUndefined();
  });

  it('removes the row on a successful delete', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') {
        return {
          ok: true,
          data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      if (message.type === 'DELETE_SAVED_FONT') return { ok: true, data: null };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove',
    ) as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'DELETE_SAVED_FONT', id: 'font-1' });
    expect(container.querySelector('.fontcia-list-row')).toBeNull();
  });

  it('re-enables the delete button and keeps the row on a failed delete', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') {
        return {
          ok: true,
          data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      if (message.type === 'DELETE_SAVED_FONT') return { ok: false, error: 'Saved font not found' };
      return { ok: true, data: null };
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove',
    ) as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.fontcia-list-row')).not.toBeNull();
    expect(deleteBtn.disabled).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/saved-fonts-view.test.ts`
Expected: FAIL — `Cannot find module '../src/account/saved-fonts-view'`.

- [ ] **Step 3: Create `src/account/saved-fonts-view.ts`**

```ts
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { SavedFontRecord } from '../background/api-client';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderSavedFontsView(
  container: HTMLElement,
  isStale: () => boolean,
  onNavigateToAccount: () => void,
): Promise<void> {
  container.replaceChildren();

  let isLoggedIn = false;
  try {
    const authRes = await sendMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
    isLoggedIn = authRes.ok && authRes.data.loggedIn;
  } catch (error: unknown) {
    console.error('fontCIA: failed to check auth state', error);
  }
  if (isStale()) return;

  if (!isLoggedIn) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = 'Log in to see your saved fonts.';
    container.appendChild(message);

    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-primary';
    loginBtn.textContent = 'Go to Account';
    loginBtn.addEventListener('click', onNavigateToAccount);
    container.appendChild(loginBtn);
    return;
  }

  let savedFonts: SavedFontRecord[] = [];
  try {
    const res = await sendMessage<SavedFontRecord[]>({ type: 'GET_SAVED_FONTS' });
    if (res.ok) savedFonts = res.data;
  } catch (error: unknown) {
    console.error('fontCIA: failed to fetch saved fonts', error);
  }
  if (isStale()) return;

  if (savedFonts.length === 0) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = "You haven't saved any fonts yet.";
    container.appendChild(message);
    return;
  }

  const list = document.createElement('div');
  for (const font of savedFonts) {
    const row = document.createElement('div');
    row.className = 'fontcia-list-row';

    const title = document.createElement('div');
    title.className = 'fontcia-list-row-title';
    title.textContent = font.fontName;
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'fontcia-list-row-meta';
    meta.textContent = `${font.confidence}% confidence · saved ${new Date(font.savedAt).toLocaleDateString()}`;
    row.appendChild(meta);

    if (font.sources.length > 0) {
      const sourcesList = document.createElement('ul');
      sourcesList.className = 'fontcia-sources';
      for (const source of font.sources) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.label;
        item.appendChild(link);
        sourcesList.appendChild(item);
      }
      row.appendChild(sourcesList);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'fontcia-btn fontcia-btn-secondary';
    deleteBtn.textContent = 'Remove';
    deleteBtn.addEventListener('click', () => {
      deleteBtn.disabled = true;
      sendMessage<null>({ type: 'DELETE_SAVED_FONT', id: font.id })
        .then((res) => {
          if (isStale()) return;
          if (res.ok) {
            row.remove();
          } else {
            console.error('fontCIA: failed to remove saved font', res.error);
            deleteBtn.disabled = false;
          }
        })
        .catch((error: unknown) => {
          if (isStale()) return;
          console.error('fontCIA: failed to remove saved font', error);
          deleteBtn.disabled = false;
        });
    });
    row.appendChild(deleteBtn);

    list.appendChild(row);
  }
  container.appendChild(list);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/saved-fonts-view.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/account/saved-fonts-view.ts tests/saved-fonts-view.test.ts
git commit -m "feat: add the account dashboard's saved fonts view"
```

---

### Task 11: `history-view.ts`

**Files:**
- Create: `src/account/history-view.ts`
- Test: `tests/history-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/history-view.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderHistoryView } from '../src/account/history-view';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('renderHistoryView', () => {
  it('shows a login prompt and calls onNavigateToAccount when logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });
    const onNavigateToAccount = vi.fn();

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, onNavigateToAccount);

    expect(container.textContent).toContain('Log in to see your scan history.');
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onNavigateToAccount).toHaveBeenCalledOnce();
  });

  it('shows an empty message when logged in with no scans', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, vi.fn());

    expect(container.textContent).toContain("You haven't scanned anything yet.");
  });

  it('renders a match row with its fontName and confidence', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') {
        return {
          ok: true,
          data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, vi.fn());

    expect(container.querySelector('.fontcia-list-row-title')?.textContent).toBe('Inter');
    expect(container.textContent).toContain('92% confidence');
  });

  it('renders a no-match row without a confidence figure', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') {
        return {
          ok: true,
          data: [{ id: 'scan-1', status: 'no-match', fontName: null, confidence: null, createdAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, vi.fn());

    expect(container.querySelector('.fontcia-list-row-title')?.textContent).toBe('No match');
    expect(container.textContent).not.toContain('% confidence');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/history-view.test.ts`
Expected: FAIL — `Cannot find module '../src/account/history-view'`.

- [ ] **Step 3: Create `src/account/history-view.ts`**

```ts
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { ScanRecord } from '../background/api-client';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderHistoryView(
  container: HTMLElement,
  isStale: () => boolean,
  onNavigateToAccount: () => void,
): Promise<void> {
  container.replaceChildren();

  let isLoggedIn = false;
  try {
    const authRes = await sendMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
    isLoggedIn = authRes.ok && authRes.data.loggedIn;
  } catch (error: unknown) {
    console.error('fontCIA: failed to check auth state', error);
  }
  if (isStale()) return;

  if (!isLoggedIn) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = 'Log in to see your scan history.';
    container.appendChild(message);

    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-primary';
    loginBtn.textContent = 'Go to Account';
    loginBtn.addEventListener('click', onNavigateToAccount);
    container.appendChild(loginBtn);
    return;
  }

  let scans: ScanRecord[] = [];
  try {
    const res = await sendMessage<ScanRecord[]>({ type: 'GET_SCANS' });
    if (res.ok) scans = res.data;
  } catch (error: unknown) {
    console.error('fontCIA: failed to fetch scan history', error);
  }
  if (isStale()) return;

  if (scans.length === 0) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = "You haven't scanned anything yet.";
    container.appendChild(message);
    return;
  }

  const list = document.createElement('div');
  for (const scan of scans) {
    const row = document.createElement('div');
    row.className = 'fontcia-list-row';

    const title = document.createElement('div');
    title.className = 'fontcia-list-row-title';
    title.textContent = scan.status === 'match' && scan.fontName ? scan.fontName : 'No match';
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'fontcia-list-row-meta';
    const confidencePart =
      scan.status === 'match' && scan.confidence !== null ? `${scan.confidence}% confidence · ` : '';
    meta.textContent = `${confidencePart}${new Date(scan.createdAt).toLocaleString()}`;
    row.appendChild(meta);

    list.appendChild(row);
  }
  container.appendChild(list);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/history-view.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/account/history-view.ts tests/history-view.test.ts
git commit -m "feat: add the account dashboard's scan history view"
```

---

### Task 12: `settings-view.ts`

**Files:**
- Create: `src/account/settings-view.ts`
- Test: `tests/settings-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/settings-view.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderSettingsView } from '../src/account/settings-view';
import { THEME_STORAGE_KEY } from '../src/shared/theme-storage';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true, email: 'a@example.com' } };
    return { ok: true, data: null };
  });
});

describe('renderSettingsView', () => {
  it('shows Dark as active when nothing is stored', async () => {
    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    const darkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Dark theme');
    expect(darkBtn?.className).toContain('fontcia-btn-primary');
  });

  it('shows Light as active when light is stored', async () => {
    await chromeMock.storage.local.set({ [THEME_STORAGE_KEY]: 'light' });

    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    const lightBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Light theme');
    expect(lightBtn?.className).toContain('fontcia-btn-primary');
  });

  it('persists the choice and calls onThemeChange when Light is clicked', async () => {
    const onThemeChange = vi.fn();
    const container = document.createElement('div');
    await renderSettingsView(container, () => false, onThemeChange);

    const lightBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Light theme',
    ) as HTMLButtonElement;
    lightBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onThemeChange).toHaveBeenCalledWith('light');
    const stored = await chromeMock.storage.local.get(THEME_STORAGE_KEY);
    expect(stored[THEME_STORAGE_KEY]).toBe('light');
    expect(lightBtn.className).toContain('fontcia-btn-primary');
  });

  it('shows the logged-in email', async () => {
    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    expect(container.textContent).toContain('Logged in as a@example.com');
  });

  it('shows a not-logged-in message when logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSettingsView(container, () => false, vi.fn());

    expect(container.textContent).toContain('Not logged in');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/settings-view.test.ts`
Expected: FAIL — `Cannot find module '../src/account/settings-view'`.

- [ ] **Step 3: Create `src/account/settings-view.ts`**

```ts
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import { getStoredTheme, setStoredTheme, type Theme } from '../shared/theme-storage';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderSettingsView(
  container: HTMLElement,
  isStale: () => boolean,
  onThemeChange: (theme: Theme) => void,
): Promise<void> {
  container.replaceChildren();

  const emailLine = document.createElement('p');
  emailLine.className = 'fontcia-list-row-meta';
  container.appendChild(emailLine);

  const themeLabel = document.createElement('p');
  themeLabel.className = 'fontcia-list-row-title';
  themeLabel.textContent = 'Theme';
  container.appendChild(themeLabel);

  const themeRow = document.createElement('div');
  const darkBtn = document.createElement('button');
  darkBtn.type = 'button';
  darkBtn.textContent = 'Dark theme';
  const lightBtn = document.createElement('button');
  lightBtn.type = 'button';
  lightBtn.textContent = 'Light theme';
  themeRow.appendChild(darkBtn);
  themeRow.appendChild(lightBtn);
  container.appendChild(themeRow);

  function renderThemeButtons(current: Theme): void {
    darkBtn.className = current === 'dark' ? 'fontcia-btn fontcia-btn-primary' : 'fontcia-btn fontcia-btn-secondary';
    lightBtn.className = current === 'light' ? 'fontcia-btn fontcia-btn-primary' : 'fontcia-btn fontcia-btn-secondary';
  }

  function handleThemeClick(theme: Theme): void {
    setStoredTheme(theme)
      .then(() => {
        if (isStale()) return;
        onThemeChange(theme);
        renderThemeButtons(theme);
      })
      .catch((error: unknown) => console.error('fontCIA: failed to save theme preference', error));
  }

  darkBtn.addEventListener('click', () => handleThemeClick('dark'));
  lightBtn.addEventListener('click', () => handleThemeClick('light'));

  const currentTheme = await getStoredTheme();
  if (isStale()) return;
  renderThemeButtons(currentTheme);

  try {
    const authRes = await sendMessage<{ loggedIn: boolean; email?: string }>({ type: 'GET_AUTH_STATE' });
    if (isStale()) return;
    emailLine.textContent =
      authRes.ok && authRes.data.loggedIn && authRes.data.email
        ? `Logged in as ${authRes.data.email}`
        : 'Not logged in';
  } catch (error: unknown) {
    if (isStale()) return;
    console.error('fontCIA: failed to check auth state', error);
    emailLine.textContent = '';
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/settings-view.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/account/settings-view.ts tests/settings-view.test.ts
git commit -m "feat: add the account dashboard's settings view with a working theme toggle"
```

---

### Task 13: `account.ts` — Tab Orchestration

**Files:**
- Create: `src/account/account.ts`
- Test: `tests/account.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/account.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

const FIXTURE_HTML = `
  <nav id="tabNav">
    <button id="tabAccount" type="button" class="fontcia-tab-btn">Account</button>
    <button id="tabSavedFonts" type="button" class="fontcia-tab-btn">Saved Fonts</button>
    <button id="tabHistory" type="button" class="fontcia-tab-btn">History</button>
    <button id="tabSettings" type="button" class="fontcia-tab-btn">Settings</button>
  </nav>
  <main id="viewContainer"></main>
`;

let chromeMock: ReturnType<typeof createChromeMock>;

async function loadAccountPage(): Promise<void> {
  document.body.innerHTML = FIXTURE_HTML;
  vi.resetModules();
  await import('../src/account/account');
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
    if (message.type === 'GET_SAVED_FONTS') return { ok: true, data: [] };
    if (message.type === 'GET_SCANS') return { ok: true, data: [] };
    return { ok: true, data: null };
  });
});

describe('account page', () => {
  it('renders the Account tab by default', async () => {
    await loadAccountPage();

    expect(document.querySelector('#viewContainer form')).not.toBeNull();
    expect(document.getElementById('tabAccount')?.classList.contains('tab-active')).toBe(true);
  });

  it('switches to the Saved Fonts view when that tab is clicked', async () => {
    await loadAccountPage();

    (document.getElementById('tabSavedFonts') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).toContain('Log in to see your saved fonts.');
    expect(document.getElementById('tabSavedFonts')?.classList.contains('tab-active')).toBe(true);
    expect(document.getElementById('tabAccount')?.classList.contains('tab-active')).toBe(false);
  });

  it('switches to the History view when that tab is clicked', async () => {
    await loadAccountPage();

    (document.getElementById('tabHistory') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).toContain('Log in to see your scan history.');
  });

  it('switches to the Settings view when that tab is clicked, reachable while logged out', async () => {
    await loadAccountPage();

    (document.getElementById('tabSettings') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).toContain('Theme');
    expect(document.getElementById('viewContainer')?.textContent).toContain('Not logged in');
  });

  it("navigates back to the Account tab when a gated view's login prompt is clicked", async () => {
    await loadAccountPage();

    (document.getElementById('tabSavedFonts') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    (document.querySelector('#viewContainer button') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('#viewContainer form')).not.toBeNull();
    expect(document.getElementById('tabAccount')?.classList.contains('tab-active')).toBe(true);
  });

  it('applies the stored theme to the document root on load', async () => {
    chromeMock = createChromeMock();
    (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
    await chromeMock.storage.local.set({ 'fontcia-theme': 'light' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });

    await loadAccountPage();

    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
  });

  it("does not paint a stale view when switching tabs before the previous view's fetch resolves", async () => {
    let resolveSavedFonts!: (value: { ok: true; data: unknown[] }) => void;
    const savedFontsPromise = new Promise((resolve) => {
      resolveSavedFonts = resolve;
    });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') return savedFontsPromise;
      if (message.type === 'GET_SCANS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    await loadAccountPage();

    (document.getElementById('tabSavedFonts') as HTMLButtonElement).click();
    await Promise.resolve();
    (document.getElementById('tabHistory') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    resolveSavedFonts({ ok: true, data: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).not.toContain("haven't saved");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/account.test.ts`
Expected: FAIL — `Cannot find module '../src/account/account'`.

- [ ] **Step 3: Create `src/account/account.ts`**

```ts
import { getStoredTheme, type Theme } from '../shared/theme-storage';
import { accountCss } from './account-theme';
import { renderAccountView } from './account-view';
import { renderSavedFontsView } from './saved-fonts-view';
import { renderHistoryView } from './history-view';
import { renderSettingsView } from './settings-view';

type Tab = 'account' | 'saved-fonts' | 'history' | 'settings';

const TAB_BUTTON_IDS: Record<Tab, string> = {
  account: 'tabAccount',
  'saved-fonts': 'tabSavedFonts',
  history: 'tabHistory',
  settings: 'tabSettings',
};

let activeTab: Tab = 'account';

function switchTab(tab: Tab): void {
  activeTab = tab;
  renderActiveTab();
}

function applyThemeToOwnPage(theme: Theme): void {
  document.documentElement.classList.toggle('theme-light', theme === 'light');
}

function renderActiveTab(): void {
  const thisTab = activeTab;
  const isStale = (): boolean => activeTab !== thisTab;

  for (const [tab, id] of Object.entries(TAB_BUTTON_IDS) as [Tab, string][]) {
    document.getElementById(id)?.classList.toggle('tab-active', tab === thisTab);
  }

  const container = document.getElementById('viewContainer') as HTMLElement;
  container.replaceChildren();

  if (thisTab === 'account') {
    void renderAccountView(container, isStale);
  } else if (thisTab === 'saved-fonts') {
    void renderSavedFontsView(container, isStale, () => switchTab('account'));
  } else if (thisTab === 'history') {
    void renderHistoryView(container, isStale, () => switchTab('account'));
  } else {
    void renderSettingsView(container, isStale, applyThemeToOwnPage);
  }
}

export async function initAccountPage(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = accountCss;
  document.head.appendChild(style);
  applyThemeToOwnPage(await getStoredTheme());

  document.getElementById('tabAccount')?.addEventListener('click', () => switchTab('account'));
  document.getElementById('tabSavedFonts')?.addEventListener('click', () => switchTab('saved-fonts'));
  document.getElementById('tabHistory')?.addEventListener('click', () => switchTab('history'));
  document.getElementById('tabSettings')?.addEventListener('click', () => switchTab('settings'));

  renderActiveTab();
}

initAccountPage();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/account.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/account/account.ts tests/account.test.ts
git commit -m "feat: add the account dashboard's tab orchestration"
```

---

### Task 14: Manifest, Build Config, and Cleanup

**Files:**
- Modify: `manifest.json`, `esbuild.config.mjs`
- Delete: `src/login/login.html`, `src/login/login.ts`, `tests/login.test.ts`

- [ ] **Step 1: Update `manifest.json`**

Change:
```json
  "web_accessible_resources": [
    {
      "resources": ["login/login.html"],
      "matches": ["<all_urls>"]
    }
  ]
```
to:
```json
  "web_accessible_resources": [
    {
      "resources": ["account/account.html"],
      "matches": ["<all_urls>"]
    }
  ]
```

- [ ] **Step 2: Update `esbuild.config.mjs`**

Change from:
```ts
await esbuild.build({
  entryPoints: { login: 'src/login/login.ts' },
  outdir: 'dist/login',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

mkdirSync('dist/login', { recursive: true });
copyFileSync('src/login/login.html', 'dist/login/login.html');
copyFileSync('manifest.json', 'dist/manifest.json');
```
to:
```ts
await esbuild.build({
  entryPoints: { account: 'src/account/account.ts' },
  outdir: 'dist/account',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

mkdirSync('dist/account', { recursive: true });
copyFileSync('src/account/account.html', 'dist/account/account.html');
copyFileSync('manifest.json', 'dist/manifest.json');
```

- [ ] **Step 3: Delete the superseded files**

```bash
git rm src/login/login.html src/login/login.ts tests/login.test.ts
```

(`src/login/` will be empty after this and can be left to disappear naturally, or removed with `rmdir src/login` if your shell requires it — git doesn't track empty directories either way.)

- [ ] **Step 4: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck; all client tests pass (the old `tests/login.test.ts` coverage is now provided by `tests/account-view.test.ts` and `tests/account.test.ts`).

- [ ] **Step 5: Build the extension and manually confirm the output**

Run: `npm run build`
Expected: builds cleanly. Confirm `dist/account/account.html` and `dist/account/account.js` exist, and `dist/login/` is no longer produced.

- [ ] **Step 6: Commit**

```bash
git add manifest.json esbuild.config.mjs
git commit -m "feat: point the manifest and build at the new account dashboard, remove the old login page"
```

---

### Task 15: Final Verification

**Files:** None (verification only).

- [ ] **Step 1: Full typecheck and test suite (client + server)**

Run (from repo root): `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Run (from `server/`): `npx tsc --noEmit && npm test` (requires Docker's `pgvector/pgvector:pg16` postgres container up)

Expected: clean typecheck on both; every test file passes, including all changes from Tasks 1-14. (Client and server suites are run separately, not via a single unscoped root `npm test` — that command's default recursive glob picks up `server/tests/` too and races two independent suites against the same live Postgres database, a pre-existing, unrelated repo quirk documented in prior sub-projects' plans.)

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: builds cleanly.

- [ ] **Step 3: Optional manual smoke test**

Requires the server running and the extension loaded unpacked in Chrome. With it running:

1. Click "Log in to save" from any no-match/result state. Confirm it opens `account.html` in a new tab, landing on the Account tab with the login form.
2. Sign up, then confirm the Account tab shows "Logged in as ...".
3. Perform a scan, save the result, then switch to the Saved Fonts tab — confirm it appears with its sources and a working Remove button.
4. Switch to the History tab — confirm the same scan (and any no-match scans) appear, newest first.
5. Switch to Settings, click "Light theme" — confirm the account page itself re-colors immediately, and confirm `chrome.storage.local` now has `fontcia-theme: 'light'` (via the extension's storage inspector or a quick `chrome.storage.local.get(null, console.log)` in the account page's devtools console).
6. With the account page still open (or closed, either way), open a new scan panel on a webpage — confirm it renders in the light theme without needing a page reload if the account tab was open when you flipped it, or immediately on the next arm if it was closed first.
7. Log out from the Account tab, then confirm Saved Fonts and History both fall back to their "log in to view" prompts.

This step is optional given the thorough automated coverage from Tasks 1-14, but is the only way to see the real, end-to-end dashboard and theme toggle working against a real backend and a real browser — worth doing at least once before considering this sub-project fully done.

- [ ] **Step 4: If a real, fixable bug was found in Step 3**, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix. If nothing broke, there's nothing to commit for this task beyond the verification itself.

---

## Self-Review Notes

- **Spec coverage:** single consolidated page with four tabs (Tasks 8-13) → covered; Settings reachable regardless of login state (Task 13's `renderActiveTab` always renders it, `settings-view.ts` never auth-gates) → covered; full scan history including no-matches (Task 1's server query, Task 11's "No match" title fallback) → covered; no pagination, capped list endpoints (`SCAN_HISTORY_LIMIT` in Task 1) → covered; settings scope limited to theme + read-only email, no password/account-deletion UI anywhere → covered; direct `chrome.storage.local` access for theme, no message-passing (Task 2's `theme-storage.ts`, used directly by both Task 3's `overlay.ts` and Task 12/13's account-page code) → covered; live-reactive theme via `chrome.storage.onChanged` mirroring the existing auth-reactivity pattern (Task 3) → covered; shared hex colors via `theme-colors.ts`, consumed by both `theme.ts` (Task 2) and `account-theme.ts` (Task 8) → covered; pure, directly-testable render-function views rather than the old fixture-HTML style (every view in Tasks 9-12) → covered; staleness guard for rapid tab-switching (the `isStale`/`isDisposed`-style callback threaded through every async view and exercised by Task 13's dedicated test) → covered; the one existing call site updated (Task 4) → covered; manifest/build/cleanup (Task 14) → covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `SavedFontRecord`/`ScanRecord` (Task 6, `api-client.ts`) are the types every consumer imports type-only (`saved-fonts-view.ts` Task 10, `history-view.ts` Task 11) — matching field names and shapes throughout (`fontName`/`confidence`/`sources`/`savedAt` for saved fonts; `status`/`fontName`/`confidence`/`createdAt` for scans), and none of the account-page files import `api-client.ts`'s functions directly (only types) — every actual network call goes through `chrome.runtime.sendMessage`, consistent with how `login.ts` never imported `api-client.ts` either and only the service worker (Task 7) does. `Theme`/`getStoredTheme`/`setStoredTheme`/`THEME_STORAGE_KEY` (Task 2) are imported identically by `overlay.ts` (Task 3) and both `settings-view.ts`/`account.ts` (Tasks 12-13). The `isStale: () => boolean` parameter shape is identical across all four view functions and the orchestrator that constructs it (Task 13), matching `locked-selection.ts`'s pre-existing `disposed`/`isDisposed()` convention this sub-project deliberately extends to a new context rather than reinventing.
