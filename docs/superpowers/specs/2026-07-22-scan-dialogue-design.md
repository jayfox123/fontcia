# fontCIA — Scan Dialogue UI Design (Sub-project 2 of 8)

**Status:** Approved
**Scope:** Build-order step 2 from `CLAUDE_CODE_INSTRUCTIONS.md` — replace the static placeholder panel body from Step 1 ("scan dialogue — goes here in step 2") with a real, stateful dialogue wired to a **mocked** response. No real backend, no real font detection, no real enrollment submission, no persistence.

## Context

Step 1 (extension shell, merged to `master`) built the crosshair → shadow-DOM overlay → drag-to-lock selection flow, ending in a locked box + a static placeholder panel (`src/content/locked-selection.ts`). This sub-project makes that panel functional: a four-state dialogue (ready / loading / result / no-match) driven by a mocked scan, matching the layout ("layout B": notch, dashed accent border, dark/light tokens) already established in `src/content/theme.ts`.

## Confirmed decisions

- **Mock determinism:** the mock's match/no-match outcome is deterministic based on `rect.width` (the drawn box's pixel width from `src/shared/selection-box.ts`'s `Rect`) — **not** actual selected text, since DOM font-resolution (reading real text nodes) is Step 3, not built yet. `rect.width < NO_MATCH_WIDTH_THRESHOLD_PX` resolves `no-match`; `rect.width >= NO_MATCH_WIDTH_THRESHOLD_PX` (including exactly at the threshold) resolves `match`.
- **"New scan" behavior:** fully dismisses the current selection and re-arms crosshair mode (equivalent to clicking the extension icon again), rather than resetting the same box back to a re-scannable ready state.
- **Save button:** toggles local UI state only (button label/style flips), no persistence across sessions — that's a later sub-project.
- **No-match "Name it" button:** present but disabled/placeholder — the real enrollment flow is a separate later sub-project.

## Architecture

Three files, split by responsibility, extending the pattern already established in Step 1 (pure DOM-builder functions, minimal state, dependency-injectable seams for testing):

- **`src/content/mock-scan.ts`** (new, pure, no DOM) — the mocked "backend call." `mockScan(rect: Rect, delayMs = MOCK_SCAN_DELAY_MS): Promise<ScanResult>` resolves after an artificial delay with either a match or no-match result, decided purely by `rect.width` against a threshold constant. Never rejects — a real API's error path is explicitly out of scope, deferred to the backend-integration sub-project.
- **`src/content/scan-dialogue.ts`** (new, pure DOM builders, no state) — one render function per state (`renderReadyState`, `renderLoadingState`, `renderResultState`, `renderNoMatchState`), each given a body container element and callbacks, rebuilding that element's children fresh on each call. Mirrors the exact stateless style `locked-selection.ts` already uses.
- **`src/content/locked-selection.ts`** (extended, not rewritten) — keeps building the box/notch/header/close-button shell exactly as today. The static placeholder body text is replaced with a closure-scoped mini state machine (`disposed`, `saved`, `currentResult` — local to each call, not module-level, so there's no cross-instance leakage) that wires Scan → loading → result/no-match, Save toggling, and New-scan, and exposes a `dispose()` alongside the existing `box`/`panel` return values.

## Data shapes

```ts
// src/content/mock-scan.ts
export interface ScanSource {
  url: string;
  label: string;
  votes: number;
}

export interface MatchResult {
  status: 'match';
  fontName: string;
  confidence: number; // 0-100
  sources: ScanSource[];
}

export interface NoMatchResult {
  status: 'no-match';
}

export type ScanResult = MatchResult | NoMatchResult;

export const NO_MATCH_WIDTH_THRESHOLD_PX = 80;
export const MOCK_SCAN_DELAY_MS = 700;

export function mockScan(rect: Rect, delayMs = MOCK_SCAN_DELAY_MS): Promise<ScanResult>;
```

Fixture match data includes a `sources` array (not a single URL) — even though real multi-source ranking logic doesn't exist yet — specifically so the result UI's shape doesn't need reworking when the multi-source sub-project (step 6) wires up real data. `votes` is included in each source now for the same reason, even though nothing sorts by it yet.

```ts
// src/content/scan-dialogue.ts
export function renderReadyState(body: HTMLElement, onScan: () => void): void;
export function renderLoadingState(body: HTMLElement): void;
export function renderResultState(
  body: HTMLElement,
  result: MatchResult,
  saved: boolean,
  onToggleSave: () => void,
  onNewScan: () => void,
): void;
export function renderNoMatchState(body: HTMLElement, onNewScan: () => void): void;
```

```ts
// src/content/locked-selection.ts
export interface LockedSelectionElements {
  box: HTMLDivElement;
  panel: HTMLDivElement;
  dispose: () => void;
}

export function renderLockedSelection(
  container: ParentNode,
  rect: Rect,
  onDismiss: () => void,
  onRestart: () => void,
  scanFn: (rect: Rect) => Promise<ScanResult> = mockScan,
): LockedSelectionElements;
```

`scanFn` is injectable (defaults to the real `mockScan`) purely so tests can substitute an instantly-resolving stub instead of waiting out the artificial delay — the same dependency-injection pattern already used for the `chrome` global mock in Step 1's tests.

## Wiring / data flow

1. `renderLockedSelection` builds the box/notch/header/close-button shell exactly as today, then calls `showReady()` to mount the ready state in the panel body.
2. **Scan click** → `renderLoadingState(body)` runs synchronously (so a second click is structurally impossible — there's no Scan button once loading starts), then `scanFn(rect)` is called. On resolution, a guard checks the closure's `disposed` flag *before* touching the DOM at all: if disposed, the result is silently discarded — no render, no error, no exception. If not disposed, `result.status === 'match'` renders the result state (storing `currentResult` for the Save-toggle re-render), otherwise renders the no-match state.
3. **Save click** (result state only) flips the closure's `saved` boolean and re-invokes `renderResultState` with the last `currentResult`.
4. **New-scan click** (result or no-match state) calls the `onRestart` callback passed in from `overlay.ts` — the dialogue itself does nothing further; restart is entirely `overlay.ts`'s responsibility.
5. **`overlay.ts` changes:**
   - A new module-level `let lockedDispose: (() => void) | null = null`, set to the `dispose` returned by `renderLockedSelection` when a selection locks.
   - `teardownOverlay()` calls `lockedDispose?.()` as its **first** action, before any other cleanup, then clears the reference. Because Esc, the panel's `×`, and an icon-click `DISMISS_SELECTION` message all already converge on the single `dismissSelection()` → `teardownOverlay()` path (established in Step 1), hooking `dispose()` into `teardownOverlay()` once covers **all three dismiss triggers** without per-trigger special-casing. This is the concrete mechanism satisfying the requirement that an in-flight mock scan cancels/no-ops regardless of which dismiss path the user takes while still in the loading state.
   - A new `restartSelection()` function: captures `currentTabId`, calls `dismissSelection()` (which itself calls `teardownOverlay()`, disposing the just-dismissed dialogue), then calls `armSelectionMode(tabId)` if the captured id was non-null.
   - `armSelectionMode(tabId)` now also calls `markSelectionActive(tabId)` (fire-and-forget, `.catch`-logged, matching the existing error-logging pattern) — this keeps the `chrome.storage.session` "active" flag correct regardless of whether arming was triggered by the background's `ARM_SELECTION` message (which already marks active before sending) or by `restartSelection`'s internal re-arm (which previously would NOT have re-marked the flag, silently breaking the double-injection guard on every "New scan").

## Error handling

The mock never rejects, so there is no error UI to design in this sub-project — the only "failure" case that matters here is the dispose/race condition already covered above (dismiss during loading), not a network or data error. A real API's failure modes are explicitly deferred to the backend-integration sub-project.

## Visual / CSS additions to `theme.ts`

New classes, using only the existing token set (no new colors introduced): `.fontcia-btn` (base), `.fontcia-btn-primary` (accent-filled, used for Scan and Save — matches the doc's "Accent/CTA: scan, save buttons" spec), `.fontcia-btn-secondary` (bordered/ghost, used for New-scan), `.fontcia-btn:disabled` (dimmed, used for the no-match "Name it" placeholder), `.fontcia-spinner` (CSS-only rotating ring using `--fontcia-accent`, no image assets), `.fontcia-result-font`, `.fontcia-confidence` (uses `--fontcia-success`), `.fontcia-sources` (scrollable list, `max-height` capped so a long source list doesn't grow the panel unboundedly), `.fontcia-source-link`, `.fontcia-no-match-message`.

## Testing

- **`mock-scan.test.ts`** — width-threshold branching (above/below/at the constant), sources array shape and non-empty, delay actually elapses before resolution (verified via a small injected `delayMs`, no fake timers needed).
- **`scan-dialogue.test.ts`** — each render function's DOM output and callback wiring in isolation (Scan button fires `onScan`, spinner has no interactive elements, result state renders font name/confidence/source count/Save button reflecting the `saved` param/New-scan button, no-match state renders message + disabled Name-it + New-scan).
- **`locked-selection.test.ts`** (extended) — full state-machine flow using an injected instant `scanFn`: ready→loading→result for a wide rect, ready→loading→no-match for a narrow rect, Save toggling across re-renders, New-scan invoking `onRestart`, and — the core new requirement — **calling `dispose()` before the injected `scanFn`'s promise resolves leaves the DOM in its pre-resolution state**, not swapped to result/no-match.
- **`overlay.test.ts`** (extended) — the true end-to-end proof: lock a selection, click Scan, then dismiss via Escape (a real dismiss path, not a direct `dispose()` call) before the mock resolves, advance past the delay, assert no result/no-match state ever renders. Also: `armSelectionMode` marks the flag active; `restartSelection` triggered via a New-scan click performs dismiss-then-rearm and leaves the flag correctly marked active for the new session.

## Out of scope for this spec

Real API calls (Step 4, backend), real enrollment submission (Step 5), saved-library persistence across sessions (Step 7), DOM font-resolution / reading actual selected text (Step 3), tier gating (Step 8), theme toggle UI (still deferred from Step 1).
