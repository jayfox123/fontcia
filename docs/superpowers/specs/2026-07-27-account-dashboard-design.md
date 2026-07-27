# fontCIA — Account Dashboard Design (Step 7)

**Status:** Approved
**Scope:** Replace the bare-bones `login.html` from the client-backend-wiring sub-project with a single, tab-based account dashboard extension page — Account (login/signup), Saved Fonts, History, Settings — and wire up a real, persisted, live-reactive theme toggle across both the new page and the existing scan-dialogue overlay.

## Context

`login.html`/`login.ts` (built in the client-backend-wiring sub-project) is intentionally bare-bones: functional but unstyled, login/signup only, no saved-library view, no scan history, no settings. `src/content/theme.ts` has carried a complete, unused `.theme-light` CSS variable set since Step 1, explicitly commented "wired now so a future toggle is a class swap, not a restyle. Not applied anywhere yet." This sub-project is that future toggle's actual home, and the natural point to grow `login.html` into the real account surface it was always going to need — `GET /saved-fonts` has existed, unconsumed by any client code, since the very first backend sub-project.

The only call site that opens the login page today is `handleLoginPrompt()` in `locked-selection.ts` (`window.open(chrome.runtime.getURL('login/login.html'), '_blank')`), reached from every existing "Log in to save" / "Log in to name it" prompt.

## Confirmed decisions

- **One consolidated page, not four.** `src/login/` becomes `src/account/`; `login.html`/`login.ts` become `account.html`/`account.ts`. Internal tab navigation (no page reloads) switches between four views. This avoids duplicating the auth-state bootstrap, theme application, and shared chrome four separate times, and means the one existing `handleLoginPrompt()` call site needs only a URL string change.
- **Settings is reachable regardless of login state.** Theme is a device preference, not an account property — flipping it doesn't require being logged in. Saved Fonts and History are account-gated: viewed while logged out, each shows a short prompt with a button that switches to the Account tab, mirroring the existing "Log in to save" pattern rather than inventing a new one.
- **Full scan history, not matches-only.** `GET /scans` (new) returns both `'match'` and `'no-match'` rows for the current user — an honest record, and it avoids adding filtering logic for no requested benefit.
- **No pagination on either list endpoint.** `GET /saved-fonts` (existing, unchanged) and the new `GET /scans` both return their full result in one response; `GET /scans` is capped at a fixed count (`SCAN_HISTORY_LIMIT = 50`) the same way `TOP_K`/`CONFIRMATION_THRESHOLD` are named, documented tunable constants elsewhere in this codebase — not true pagination, matching the "v1 scale doesn't need it" precedent already set by `GET /font-submissions/pending`.
- **Settings ships only the theme toggle and a read-only account-email display.** Password change and account deletion are explicitly out of scope — neither was requested, and neither has any backend route today.
- **Theme storage is direct `chrome.storage.local` access, not message-passing.** Unlike auth tokens (which need service-worker-mediated refresh logic and so are read/written only via messages), a plain theme preference has no such requirement. Both the content script and the account page already have the `"storage"` permission and can read/write it directly, exactly like `session-state.ts` already does for `chrome.storage.session`.
- **Theme changes propagate live to an already-open scan panel**, via a `chrome.storage.onChanged` listener in `overlay.ts` — the identical mechanism `locked-selection.ts` already uses to live-update Save-button state when auth changes in another tab, applied to a second storage key.
- **Hex color values live in one place.** A new `src/shared/theme-colors.ts` exports the dark/light CSS-custom-property bodies; both `theme.ts` (the floating panel) and the new account page's own stylesheet interpolate them, rather than each hardcoding its own copy of the same six colors.
- **The new view modules are pure, directly-testable render functions** (`render*View(container, ...deps)`, plain DOM construction — the pattern already established by `scan-dialogue.ts`/`enrollment.ts`), not the self-executing-on-import + hidden/shown-HTML-fixture style `login.ts` currently uses. Since this sub-project already rewrites the whole directory, this is folded in as part of that rewrite rather than treated as a separate, unrelated refactor.
- **Rapid tab-switching is guarded the same way in-flight async renders are guarded elsewhere** (`locked-selection.ts`'s `disposed` flag, `enrollment.ts`'s `isDisposed()`): each async view render checks whether its tab is still the active one immediately before touching the DOM, so a slow Saved Fonts fetch can't paint stale content after the user has already switched to History.
- **No deep-linking from "Log in to save" etc. to a specific tab.** Every login prompt continues to open straight to the Account tab, exactly like today. Worth a future enhancement, not part of this scope.

## Architecture

### File structure

```
src/account/
  account.html          — thin shell: tab nav + an empty view container, plus <script src="account.js">
  account.ts             — bootstraps theme + auth, wires tab clicks, owns the active-tab/staleness guard
  account-view.ts        — renderAccountView(container): login/signup form, or logged-in email + logout
                            (ports today's login.ts logic into the render-function pattern)
  saved-fonts-view.ts    — renderSavedFontsView(container, onNavigateToAccount): list + delete
  history-view.ts        — renderHistoryView(container, onNavigateToAccount): list, read-only
  settings-view.ts       — renderSettingsView(container, onThemeChange): theme toggle + email display
  account-theme.ts        — accountCss: full-page dashboard styles (tabs, list rows, forms),
                            interpolating theme-colors.ts the same way theme.ts does

src/shared/
  theme-colors.ts         — DARK_THEME_VARS / LIGHT_THEME_VARS: raw CSS custom-property declarations,
                            no selector wrapper (theme.ts wraps them in .fontcia-surface{}, account-theme.ts
                            wraps them in :root{})
  theme-storage.ts         — Theme type, THEME_STORAGE_KEY, getStoredTheme()/setStoredTheme() — direct
                            chrome.storage.local access, default 'dark' when nothing is stored

src/content/theme.ts       — modified: hex values replaced by DARK_THEME_VARS/LIGHT_THEME_VARS interpolation,
                            no other change
src/content/overlay.ts     — modified: applies the stored theme to a newly-created panel, and live-updates
                            an already-open one via chrome.storage.onChanged
src/content/locked-selection.ts — modified: handleLoginPrompt's URL string only

src/shared/api-messages.ts — gains GET_SAVED_FONTS, GET_SCANS
src/background/api-client.ts — gains getSavedFonts(), getScans()
src/background/service-worker.ts — two new dispatch cases

server/src/routes/scans.ts — gains GET / (requireAuth, scoped, capped, newest-first)

manifest.json               — web_accessible_resources path updated
esbuild.config.mjs           — entry point / output directory updated
```

`src/login/` and its test file are removed as part of this rename, not left alongside the new directory.

### Database / server

No schema change. `server/src/routes/scans.ts` gains:

```ts
const SCAN_HISTORY_LIMIT = 50; // v1 cap, not true pagination — same treatment as this
                                 // project's other list-endpoint size limits (e.g. TOP_K)

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

`GET /` is the only route on this router needing `requireAuth` — `POST /` keeps its existing `optionalAuth` (anonymous scanning stays fully supported), so `requireAuth` is applied per-route here rather than router-wide, matching `font-matches.ts`'s existing precedent for a router with mixed auth requirements.

### Client message contracts

```ts
// src/shared/api-messages.ts additions
| { type: 'GET_SAVED_FONTS' }
| { type: 'GET_SCANS' }
```

`api-client.ts`:
```ts
export interface SavedFontRecord {
  id: string;
  fontName: string;
  confidence: number;
  sources: ScanSource[];
  savedAt: string;
}

export async function getSavedFonts(): Promise<ApiResponse<SavedFontRecord[]>> {
  const result = await apiFetch<{ savedFonts: SavedFontRecord[] }>('/saved-fonts', { method: 'GET', auth: 'required' });
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

Both follow `getPendingSubmissions`'s exact existing shape (unwrap the named array field, `auth: 'required'`). `service-worker.ts`'s `handleApiMessage` gains two matching one-line cases, no new error handling beyond the switch's existing outer try/catch.

### Theme colors and storage

```ts
// src/shared/theme-colors.ts
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

```ts
// src/shared/theme-storage.ts
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

`theme.ts` changes only its variable block:
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
/* ...everything else in this file is unchanged... */
`;
```

### `overlay.ts` — applying and live-updating the theme

`createOverlay()` stays synchronous (the crosshair cursor and drag-handling must be available immediately — no user-visible delay is acceptable there). Theme application is a separate, fire-and-forget async step appended at the end of the existing synchronous build:

```ts
async function applyStoredTheme(): Promise<void> {
  if (!shadowSurface) return;
  const theme = await getStoredTheme();
  if (!shadowSurface) return; // could have been torn down while this awaited
  shadowSurface.classList.toggle('theme-light', theme === 'light');
}

function createOverlay(): void {
  // ...unchanged through shadowSurface creation, cursor, and its 3 event listeners...
  void applyStoredTheme();
  document.addEventListener('keydown', handleKeydown);
}
```

Inside the existing `if (!window.__fontciaOverlayInjected)` module-load guard, alongside the existing `chrome.runtime.onMessage` listener registration, one more listener is added:
```ts
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && THEME_STORAGE_KEY in changes) {
    void applyStoredTheme();
  }
});
```
`applyStoredTheme()` already no-ops when `shadowSurface` is null, so this is safe to fire whether or not a panel is currently open.

### `account.ts` — orchestration and the staleness guard

```ts
type Tab = 'account' | 'saved-fonts' | 'history' | 'settings';

let activeTab: Tab = 'account';

function switchTab(tab: Tab): void {
  activeTab = tab;
  renderActiveTab();
}

function renderActiveTab(): void {
  const thisTab = activeTab;
  const isStale = (): boolean => activeTab !== thisTab;
  // ...update tab button active styling...
  const container = document.getElementById('viewContainer') as HTMLElement;
  container.replaceChildren();
  if (thisTab === 'account') void renderAccountView(container, isStale);
  else if (thisTab === 'saved-fonts') void renderSavedFontsView(container, isStale, () => switchTab('account'));
  else if (thisTab === 'history') void renderHistoryView(container, isStale, () => switchTab('account'));
  else void renderSettingsView(container, isStale, applyThemeToOwnPage);
}

function applyThemeToOwnPage(theme: Theme): void {
  document.documentElement.classList.toggle('theme-light', theme === 'light');
}

export async function initAccountPage(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = accountCss;
  document.head.appendChild(style);
  applyThemeToOwnPage(await getStoredTheme());

  document.getElementById('tabAccount')!.addEventListener('click', () => switchTab('account'));
  document.getElementById('tabSavedFonts')!.addEventListener('click', () => switchTab('saved-fonts'));
  document.getElementById('tabHistory')!.addEventListener('click', () => switchTab('history'));
  document.getElementById('tabSettings')!.addEventListener('click', () => switchTab('settings'));

  renderActiveTab();
}

initAccountPage();
```

Every async view function's contract: do all fetching first, call `if (isStale()) return;` immediately before the first DOM write, exactly mirroring the `if (disposed) return;` checks already used throughout `locked-selection.ts`.

### The four views

- **`renderAccountView(container, isStale)`** — today's `login.ts` logic (mode toggle, form submit, error display, logged-in email + logout), restructured into DOM construction inside `container` instead of showing/hiding a static HTML fixture. Behavior is otherwise unchanged: `GET_AUTH_STATE` on entry, `LOGIN`/`SIGNUP` on submit, `LOGOUT` on click.
- **`renderSavedFontsView(container, isStale, onNavigateToAccount)`** — checks `GET_AUTH_STATE` first; logged out shows a message + a button calling `onNavigateToAccount`. Logged in: `getSavedFonts()`, render each as fontName / confidence / a `sources` link list (reusing the same list-of-links shape `renderResultState` already renders) / a formatted `savedAt` date / a delete button wired to the existing `DELETE_SAVED_FONT` message, removing that row from the in-memory list and re-rendering on success.
- **`renderHistoryView(container, isStale, onNavigateToAccount)`** — same auth-gate pattern. Logged in: `getScans()`, render each row's status, fontName (or an explicit "no match" label when absent), confidence, and formatted `createdAt`. No delete action — nothing in the schema or any existing route supports deleting a scan, and it wasn't requested.
- **`renderSettingsView(container, isStale, onThemeChange)`** — always renders regardless of auth state. Fetches `getStoredTheme()` and (best-effort) `GET_AUTH_STATE` for the read-only email line. Two buttons, "Dark theme" / "Light theme", styled with the existing `.fontcia-btn-primary` (current selection) / `.fontcia-btn-secondary` (the other) convention already used for the saved/unsaved toggle elsewhere — clicking one calls `setStoredTheme(theme)` then `onThemeChange(theme)` (which updates the account page's own `<html>` class; the content-script overlay picks up the change independently via its own `chrome.storage.onChanged` listener) and re-renders the two buttons' active state.

### Manifest and build

```json
"web_accessible_resources": [
  { "resources": ["account/account.html"], "matches": ["<all_urls>"] }
]
```

`esbuild.config.mjs`: the `login` entry point/outdir/copy step become `account`, pointing at `src/account/account.ts` / `dist/account/`.

`locked-selection.ts`'s `handleLoginPrompt()` changes only its URL string, from `'login/login.html'` to `'account/account.html'`.

## Testing

Same established split: `server/tests/scans.test.ts` gains real-HTTP/real-Postgres coverage for the new `GET /` (auth required, scoped to the caller, newest-first, includes both match and no-match rows, respects the cap). Client-side, each of the four view modules and the orchestrator get their own test file against mocked `chrome.runtime`/`chrome.storage`, following the `scan-dialogue.ts`/`enrollment.ts` pattern of constructing a fresh `<div>` and calling the render function directly rather than the fixture-HTML style `tests/login.test.ts` used — that file is replaced (not kept alongside) by `tests/account-view.test.ts` plus `tests/account.test.ts`'s own tab-switching/staleness coverage. `theme-storage.ts` and `theme-colors.ts` get direct unit coverage (default-to-dark, round-trip storage). `overlay.test.ts` gains coverage for theme application on creation and live-update via `chrome.storage.onChanged`. `locked-selection.test.ts`'s existing `window.open` URL assertion is updated to the new path.

## Out of scope for this spec

Password change, account deletion, email change — none has backend support today and none was requested. Deep-linking a login prompt to a specific destination tab. Pagination (both list endpoints return their full, capped result in one response). Syncing theme preference across devices (`chrome.storage.local` is per-install, not `.sync`, matching how auth tokens already behave). A "system theme" auto-detect option — only an explicit two-way toggle. Editing or deleting individual scan-history entries. Any change to `SavedFont`/`Scan` schema.
