# fontCIA — Client/Backend Wiring Design (Sub-project 4b of 8)

**Status:** Approved
**Scope:** Wire the existing extension client to the backend server built in sub-project 4a: real persistence for the Save button (`POST`/`DELETE /saved-fonts`), scan-outcome logging (`POST /scans`), a bare-bones (functional-only, unstyled) login/signup flow, and token storage/refresh via `chrome.storage.local`. Real login-UI design/polish is explicitly deferred to a future step.

## Context

Sub-project 4a (merged to `master`) built a standalone Express/Prisma/Postgres backend with three route groups (`/auth`, `/saved-fonts`, `/scans`) and JWT access + rotating opaque refresh tokens. The extension client (Steps 1-3) is currently 100% local/offline: `resolveFontFromSelection` does DOM-based font detection entirely in the content script, and "saving" a font is just an in-memory boolean toggle inside `locked-selection.ts`'s closure — never persisted, lost on dismiss. There is currently no HTTP client, no `host_permissions`, no `chrome.storage.local` usage, and no login surface anywhere in the extension.

Font resolution itself is **not** changing here — `resolveFontFromSelection` stays fully local. The backend's `/scans` endpoint is pure telemetry (`{status, fontName?, confidence?} → {id, createdAt}`), not a font-lookup endpoint.

## Confirmed decisions

- **All backend communication is proxied through the background service worker**, via typed `chrome.runtime` messages extending the existing `ARM_SELECTION`/`DISMISS_SELECTION` pattern — never a direct `fetch()` from a content script or the login page. This avoids host-page CSP entirely (the background script runs in the extension's own origin) and gives one single-process choke point for token storage and refresh.
- **Token refresh is reactive-with-retry, single-flighted**: attach the stored access token if present → on `401`, refresh once → retry the original request once → on refresh failure, clear stored auth (now logged out). Concurrent requests share one in-flight refresh `Promise` so two simultaneous `401`s never both call `/auth/refresh` (which would race against the server's single-use, rotating refresh token and strand the loser logged out).
- **Tokens persist in `chrome.storage.local`** (not `session`), so login survives a browser restart. Already covered by the existing `storage` manifest permission.
- **Login lives on a separate, dedicated extension page** (`login.html`), opened via `window.open(chrome.runtime.getURL('login.html'), '_blank')` from a link inside the locked-selection panel — never a `default_popup` (would break `chrome.action.onClicked`, the foundation of crosshair-selection). The page is bare-bones: functional email/password fields, a log-in/sign-up mode toggle, plain-text error display, no styling pass.
- **The Save button is replaced, not disabled, when logged out**: `renderResultState` gains an `isLoggedIn` parameter; logged-out renders a "Log in to save" link instead of the Save/Saved toggle.
- **Cross-tab reactivity via `chrome.storage.onChanged`**: since the login page runs in a separate tab from the panel that prompted it, the locked-selection panel listens for changes to the stored-auth key and re-renders its Save area when login state changes elsewhere.
- **Scan logging is fire-and-forget**, dispatched alongside the (already-immediate) local result render, never awaited, failures silently swallowed. It cannot add latency to the scan flow because it isn't on the render path at all.

## Architecture

### New/changed files

```
manifest.json                        — add host_permissions, web_accessible_resources
src/shared/api-config.ts             — API_BASE_URL constant (new)
src/shared/api-messages.ts           — message/response type definitions (new)
src/background/auth-storage.ts       — chrome.storage.local read/write/clear for the auth record (new)
src/background/api-client.ts         — apiFetch() with attach/401-refresh/retry/single-flight (new)
src/background/service-worker.ts     — new onMessage handler for the ApiMessage union (modified)
src/content/locked-selection.ts      — async save/delete, auth-state check, onChanged listener (modified)
src/content/scan-dialogue.ts         — renderResultState gains isLoggedIn param (modified)
src/login/login.html                 — new bare-bones extension page (new)
src/login/login.ts                   — login/signup/logout page logic (new)
esbuild.config.mjs                   — new entry point for the login page bundle (modified)
```

### Message protocol

`src/shared/api-messages.ts` defines a discriminated union sent via `chrome.runtime.sendMessage`, and a uniform response envelope so every caller handles success/failure the same way regardless of endpoint:

```ts
export type ApiMessage =
  | { type: 'SIGNUP'; email: string; password: string }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'SAVE_FONT'; fontName: string; confidence: number; sources: ScanSource[] }
  | { type: 'DELETE_SAVED_FONT'; id: string }
  | { type: 'LOG_SCAN'; status: 'match' | 'no-match'; fontName?: string; confidence?: number };

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```

Per-message response payloads:
- `SIGNUP` / `LOGIN` → `{ user: { id: string; email: string } }` (tokens are stored internally by the background script and never returned to the caller — content scripts and the login page only ever need to know *whether* they're logged in, not the token values).
- `LOGOUT` → `null`.
- `GET_AUTH_STATE` → `{ loggedIn: boolean; email?: string }` — a pure local read of `chrome.storage.local` (checks whether a stored auth record exists; does not validate the access token's freshness against the server, no network call, effectively instant). An access token that has silently expired still reports `loggedIn: true` here — the actual refresh happens lazily on the next real API call via the 401-retry logic in `api-client.ts`, not proactively at this check.
- `SAVE_FONT` → `{ id: string }` (the server-assigned `SavedFont.id`, needed later for delete).
- `DELETE_SAVED_FONT` → `null`.
- `LOG_SCAN` → `null` (callers don't need to inspect this; the background script still resolves the message so it can log a failure to its own console).

### Token storage (`src/background/auth-storage.ts`)

Single key `fontcia-auth` in `chrome.storage.local`:

```ts
interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO string, access token expiry — informational, not used to gate requests
  userId: string;
  email: string;
}
```

Absent/null key = logged out. This module is the *only* code that reads or writes this key — `api-client.ts` and the message handler go through it, nothing else touches `chrome.storage.local` directly for auth.

### `src/background/api-client.ts`

Central `apiFetch(path, { method, body, auth })` where `auth` is `'required' | 'optional' | 'none'`:
1. Reads stored auth. If `auth === 'required'` and none exists, fail fast with a clear error (a safety net — callers should already have checked `GET_AUTH_STATE` first).
2. If `auth !== 'none'` and a token exists, attaches `Authorization: Bearer <accessToken>`.
3. Makes the request against `API_BASE_URL + path`.
4. On `401` (and `auth !== 'none'` and a refresh token exists): calls `ensureFreshToken()` (below), then retries the original request once with the new access token. If refresh fails, clears stored auth and returns the original failure.
5. Returns `{ ok: true, data }` or `{ ok: false, error }`, matching `ApiResponse<T>`.

Single-flight refresh guard:
```ts
let refreshInFlight: Promise<boolean> | null = null;

async function ensureFreshToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
```
`doRefresh()` POSTs the stored `refreshToken` to `/auth/refresh`; on success, overwrites stored auth with the new pair; on failure, clears stored auth. This guard is a module-level variable scoped to the service worker's current in-memory lifetime — sufficient because MV3 handles concurrent `onMessage` events within one active instance without spinning up parallel instances; a service-worker restart only happens between bursts of activity, not mid-burst, so it doesn't need to survive restarts.

### `src/background/service-worker.ts`

Adds one `chrome.runtime.onMessage` listener handling the `ApiMessage` union (alongside the existing `ARM_SELECTION`/`DISMISS_SELECTION` handling, unchanged), dispatching each message type to the corresponding `api-client.ts`/`auth-storage.ts` call and returning the `ApiResponse` via the async-response pattern (`return true` + `sendResponse`, or an async listener returning a `Promise`, matching whichever idiom the existing handler already uses).

### `src/content/locked-selection.ts` changes

- Closure state: replace the bare `saved: boolean` with `savedFontId: string | null` (derived `saved = savedFontId !== null`).
- Before rendering a match result, send `GET_AUTH_STATE`; pass the result into `renderResultState` as `isLoggedIn`.
- `handleToggleSave` becomes async:
  - Not saved → send `SAVE_FONT` with `{fontName, confidence, sources}` from `currentResult`; on success, set `savedFontId = data.id`, re-render as Saved. On failure, leave state unchanged, `console.error`, re-render as not-saved (unchanged).
  - Saved → send `DELETE_SAVED_FONT` with `{id: savedFontId}`; on success, `savedFontId = null`, re-render as not-saved. On failure, leave state unchanged, `console.error`.
  - Disable the Save button for the duration of the in-flight request (prevents double-submit); re-enable on response.
  - Guarded by the existing `disposed` check before any DOM write, same pattern already used for the scan promise.
- New "Log in to save" click handler: `window.open(chrome.runtime.getURL('login.html'), '_blank')`.
- New `chrome.storage.onChanged` listener, registered when the panel is created and removed in `dispose()`: on a change to the `fontcia-auth` key in the `local` area, if `currentResult` is currently a match, re-check `GET_AUTH_STATE` and re-render the result state's Save area (so a login completed in the other tab is reflected without the user needing to re-scan).
- `handleScan`'s existing `.then(result => { ... })` gains one more, non-blocking line: fire (don't await) `chrome.runtime.sendMessage({ type: 'LOG_SCAN', status: result.status, fontName: ..., confidence: ... })` with a no-op `.catch()`. No `disposed` guard needed here since it touches no DOM.

### `src/content/scan-dialogue.ts` changes

`renderResultState(body, result, saved, onToggleSave, onNewScan)` becomes `renderResultState(body, result, saved, onToggleSave, onNewScan, isLoggedIn)`: when `isLoggedIn` is `false`, the Save/Saved button is replaced with a "Log in to save" link/button wired to a new `onLoginPrompt` callback instead of `onToggleSave`.

### `src/login/login.html` + `login.ts`

A new, separate, minimal HTML page (own esbuild entry point) with no shared styling from the panel. On load: sends `GET_AUTH_STATE`; if already logged in, shows "Logged in as `<email>`" plus a functional Log Out button, instead of the form. Otherwise shows a simple form (email/password inputs, a Log In / Sign Up mode toggle, one submit button) that sends `LOGIN` or `SIGNUP` on submit. On success, shows a plain "Logged in — you can close this tab" confirmation. On failure, shows the raw `error` string from the response in a plain text element. Log Out sends `LOGOUT` and returns the page to the form.

### `manifest.json` changes

```json
"host_permissions": ["http://localhost:3001/*"],
"web_accessible_resources": [
  { "resources": ["login.html"], "matches": ["<all_urls>"] }
]
```
`web_accessible_resources` is declared defensively even though top-level navigation via `window.open` to an extension's own page is generally allowed without it — cheap to add, removes any ambiguity, no meaningful security cost for a static bundled page. The exact resource path (`login.html` vs. a subdirectory) depends on the bundler's actual output layout — confirmed against `esbuild.config.mjs`'s real output structure at plan-writing time, not fixed here.

### Backend origin (`src/shared/api-config.ts`)

```ts
export const API_BASE_URL = 'http://localhost:3001';
```
Hardcoded for this dev-focused pass — there is no deployed production server yet, so an environment-config system would be speculative. **Known limitation**, tracked as future work once a real deployment target exists.

## Data mapping

- `POST /saved-fonts` body: `{ fontName: currentResult.fontName, confidence: currentResult.confidence, sources: currentResult.sources }` — direct 1:1 mapping; the backend's `SavedFont.sources` is already documented as a denormalized snapshot of exactly this `ScanSource[]` shape, no transformation needed.
- `POST /scans` body: `{ status: result.status, fontName: result.status === 'match' ? result.fontName : undefined, confidence: result.status === 'match' ? result.confidence : undefined }`.

## Error handling philosophy

Bare-bones by design, matching the "functional only, no polish" scope: no toasts, no retry UI, no offline detection. Save/unsave failures revert silently (console error only) rather than showing an inline banner. Scan-log failures are fully silent. The login page is the one place a user-facing error message appears at all, and it's the raw API error string with no additional formatting.

## Testing

Consistent with this project's established split: unit-test everything that's pure/mockable, defer real-browser-only behavior to manual QA.

- **Unit-testable with mocked `fetch` and mocked `chrome.storage.local`** (extending the existing `chrome-mock.ts` helper): `api-client.ts`'s attach/401-refresh/retry logic, the single-flight refresh guard (two concurrent 401s → one refresh call), `auth-storage.ts`'s read/write/clear, message-handler dispatch in `service-worker.ts`, and `locked-selection.ts`'s async save/delete/auth-state flow (mocking `chrome.runtime.sendMessage` responses, the same way DOM/scan mocking already works in that file's existing tests).
- **Manual-QA only** (real-browser-only, consistent with how DOM sampling and icon-click-on-restricted-pages were handled in earlier steps): `window.open` actually opening `login.html` in a new tab, `chrome.storage.onChanged` actually firing across tab contexts, and the full real network round-trip against a running backend server.

## Out of scope for this spec

Polished/styled login UI (a future step). Server-side font resolution. Enrollment/moderation. Usage/tier limit enforcement. Environment-based API URL configuration for a real deployment (hardcoded `localhost:3001` for now — known limitation). The "Name it" no-match button (remains a stub, untouched).
