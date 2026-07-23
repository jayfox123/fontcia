# fontCIA — DOM Font-Resolution Logic Design (Sub-project 3 of 8)

**Status:** Approved
**Scope:** Build-order step 3 from `CLAUDE_CODE_INSTRUCTIONS.md` — replace `src/content/mock-scan.ts`'s `rect.width`-based determinism with real font detection: read actual DOM text under the locked selection rectangle, resolve its computed `font-family`/`font-weight`/`font-style`, and look that up against a bundled known-fonts table to produce a real `ScanResult`, feeding into the exact same ready/loading/result/no-match dialogue UI built in Step 2.

## Context

Step 2 (scan dialogue, merged to `master`) built a four-state dialogue driven by `mock-scan.ts`, whose match/no-match outcome was deterministic on the drawn box's pixel width — an intentional stand-in, since real DOM font-resolution was explicitly out of scope there. This sub-project builds that real resolution logic and wires it in as the new default for `locked-selection.ts`'s injectable `scanFn` seam, which was designed in Step 2 specifically to make this swap possible without touching the dialogue's rendering code.

## Confirmed decisions

- **Sampling strategy:** a 5×5 grid (25 points) across the selection rect, inset 10%–90% per axis so points never land exactly on the box's own border. `document.caretRangeFromPoint` is the primary hit-test (Chrome-only API, fine since this is a Chrome-only extension; resolves to the actual text node at a pixel, not just an element), with `document.elementsFromPoint` as a fallback for points where `caretRangeFromPoint` returns null.
- **Multi-font selections:** tally the computed `{fontFamily, fontWeight, fontStyle}` signature from every successfully-resolved sample point. The most common signature wins if it represents at least **60%** of resolved samples (`MAJORITY_THRESHOLD = 0.6`); otherwise the selection is treated as genuinely mixed.
- **Known-fonts table:** a bundled static dataset (`src/content/known-fonts.ts`), reusing the existing `ScanSource` shape from Step 2 so a real match slots into `MatchResult` with zero reshaping. Seeded with 10 Google Fonts: Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Nunito, Source Sans Pro, Playfair Display, Merriweather.
- **Confidence:** reframed from Step 2's arbitrary fuzzy-match percentage to the **sample-agreement percentage** — the same share computed for the majority vote. A tight single-font selection reads ~100%; a selection clipping into a neighboring differently-styled run reads lower (but still ≥60%, or it wouldn't have won). Keeps the same `confidence: number` field, so `scan-dialogue.ts` needs no changes. *Known UX nuance, deferred, not fixed now: this percentage may read to users as "detection accuracy" rather than "selection precision" — worth a copy/label pass in a future polish round.*
- **Full replacement:** `mock-scan.ts` and `tests/mock-scan.test.ts` are deleted outright, not kept alongside. Every consumer is updated, no parallel/dead code path.
- **Perceived-loading floor:** the real resolution finishes near-instantly (no network round trip), which would make the loading spinner flash invisibly and would remove any real window to manually test dispose-during-loading. A fixed minimum duration (`MIN_SCAN_DURATION_MS`, ~175ms) is added inside the real `resolveFontFromSelection` only — not as a wrapper around the generic `scanFn` seam — so the many existing tests that inject a fake instantly-resolving `scanFn` (Step 2's `locked-selection.test.ts`, `overlay-dialogue-integration.test.ts`) stay fast and are completely unaffected; only the real production path gets the perceptible delay.

## Architecture

Four new files, split by responsibility, extending Step 2's pattern of separating pure/testable logic from browser-only/manually-verified logic:

- **`src/content/scan-types.ts`** (new) — `ScanSource`/`MatchResult`/`NoMatchResult`/`ScanResult` move out of `mock-scan.ts` into an implementation-agnostic home, since the type contract shouldn't live inside the module being deleted. `NoMatchResult` gains an additive `reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error'` field — captured now, not yet displayed differently by `scan-dialogue.ts` (deferred to a future polish pass, alongside the confidence-label nuance above).
- **`src/content/dom-sampling.ts`** (new) — split into a pure half and a browser-only half:
  - `generateSamplePoints(rect: Rect): Point[]` — pure grid math, fully unit-tested.
  - `readFontAtPoint(point: Point): FontReading | null` — the one function touching real browser APIs jsdom cannot simulate (no `caretRangeFromPoint`; `elementsFromPoint` returns empty). Not unit-tested; verified only by the manual Chrome checklist, the same treatment Step 1 gave crosshair/click-through behavior.
  - `sampleRect(rect: Rect): FontReading[]` — composes the two, filtering out points where no text was found.
- **`src/content/known-fonts.ts`** (new) — `KNOWN_FONTS: KnownFont[]` plus `findKnownFont(fontFamilyStack: string): KnownFont | null`, fully pure and unit-tested.
- **`src/content/font-resolver.ts`** (new) — the pure decision logic (`resolveFromReadings`, fully unit-tested) plus the composed, real-world default (`resolveFontFromSelection`, not independently unit-tested since it composes the untestable `sampleRect`).
- **Deleted:** `src/content/mock-scan.ts`, `tests/mock-scan.test.ts`.
- **Modified:** `src/content/locked-selection.ts` (type imports move to `./scan-types`; `scanFn` default changes from `mockScan` to `resolveFontFromSelection`; `handleScan` gains a `.catch` — see Error Handling), `src/content/scan-dialogue.ts` (type import moves to `./scan-types`, no rendering changes), `tests/locked-selection.test.ts` and `tests/overlay-dialogue-integration.test.ts` (type imports and `vi.mock` targets repointed from `mock-scan`/`mockScan` to `font-resolver`/`resolveFontFromSelection`; test structure itself unchanged).

## Data shapes

```ts
// src/content/scan-types.ts
export interface ScanSource {
  url: string;
  label: string;
  votes: number;
}

export interface MatchResult {
  status: 'match';
  fontName: string;
  confidence: number; // 0-100, sample-agreement percentage
  sources: ScanSource[];
}

export interface NoMatchResult {
  status: 'no-match';
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
}

export type ScanResult = MatchResult | NoMatchResult;
```

```ts
// src/content/dom-sampling.ts
import type { Point, Rect } from '../shared/selection-box';

export const SAMPLE_GRID_SIZE = 5; // 5x5 = 25 points

export function generateSamplePoints(rect: Rect): Point[];

export interface FontReading {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
}

export function readFontAtPoint(point: Point): FontReading | null;

export function sampleRect(rect: Rect): FontReading[];
```

```ts
// src/content/known-fonts.ts
import type { ScanSource } from './scan-types';

export interface KnownFont {
  name: string;
  matchKeys: string[]; // normalized (lowercase, unquoted) family names to match against
  license: string;
  sources: ScanSource[];
}

export const KNOWN_FONTS: KnownFont[]; // 10 seed entries

export function findKnownFont(fontFamilyStack: string): KnownFont | null;
```

```ts
// src/content/font-resolver.ts
import type { Rect } from '../shared/selection-box';
import type { ScanResult } from './scan-types';
import type { FontReading } from './dom-sampling';

export const MAJORITY_THRESHOLD = 0.6;
export const MIN_SCAN_DURATION_MS = 175;

export function resolveFromReadings(readings: FontReading[]): ScanResult;

export function resolveFontFromSelection(rect: Rect): Promise<ScanResult>;
```

## Wiring / data flow

1. `resolveFromReadings` tallies signatures via a `${fontFamily}|${fontWeight}|${fontStyle}` key. Zero readings → `{ status: 'no-match', reason: 'no-text' }`. Winning share below `MAJORITY_THRESHOLD` → `{ status: 'no-match', reason: 'mixed' }`. Winning signature's `fontFamily` not found via `findKnownFont` → `{ status: 'no-match', reason: 'unrecognized' }`. Otherwise → `{ status: 'match', fontName: known.name, confidence: Math.round(share * 100), sources: known.sources }`. (Tie-breaking among signatures with equal top counts is unspecified and doesn't need to be: two disjoint groups can't both clear a 60% threshold of the same total, so whichever tied signature is arbitrarily picked as "the max" can only ever change the outcome when neither would have passed the threshold anyway — the result is `mixed` either way.)
2. `resolveFontFromSelection(rect)` samples synchronously (`resolveFromReadings(sampleRect(rect))`) but wraps the resolution in a `setTimeout(..., MIN_SCAN_DURATION_MS)` so it never resolves faster than the perceived-loading floor, regardless of how fast the real sampling was.
3. `locked-selection.ts`'s `scanFn` default parameter changes from `mockScan` to `resolveFontFromSelection`; the injectable seam itself (`scanFn: (rect: Rect) => Promise<ScanResult> = resolveFontFromSelection`) is otherwise untouched, so Step 2's tests continue injecting their own fast fake `scanFn` exactly as before.
4. `findKnownFont` parses the CSS font stack (comma-split, strip quotes/whitespace, lowercase) and tries each entry in stack order, returning the first one present in `KNOWN_FONTS` — mirroring real font-fallback semantics (leftmost available wins), since `getComputedStyle().fontFamily` returns the authored stack, not which specific font actually rendered.

## Error handling

`mockScan` could never reject; real `caretRangeFromPoint`/`elementsFromPoint`/`getComputedStyle` calls theoretically can throw. Currently `locked-selection.ts`'s `handleScan` does `scanFn(rect).then(...)` with no `.catch` — safe when the promise can't reject, not safe now. Add a `.catch` that logs (matching the `.catch`-log pattern already used everywhere else in this codebase — `session-state.ts` calls, `service-worker.ts`, `overlay.ts`) and falls back to rendering the no-match state with `reason: 'error'`, so an unexpected failure can't leave the dialogue stuck on the spinner forever. This is a concrete, motivated addition (a new failure mode that genuinely didn't exist before), not speculative defensive coding.

## Testing

- **`dom-sampling.test.ts`** — `generateSamplePoints`: exactly 25 points for the default grid, all points within the rect's 10%–90% inset bounds, correct spacing. `readFontAtPoint`/`sampleRect` are not unit-tested (real browser APIs jsdom can't simulate).
- **`known-fonts.test.ts`** — `findKnownFont`: exact match, case-insensitive match, quoted family names (`"Inter", sans-serif`), first-in-stack-wins when multiple stack entries could match, returns `null` for a completely unknown font.
- **`font-resolver.test.ts`** — `resolveFromReadings`: unanimous readings → match with confidence 100; readings just above/below the 60% threshold boundary; empty readings → no-match/no-text; readings that agree but whose font isn't in `KNOWN_FONTS` → no-match/unrecognized; readings split below threshold → no-match/mixed.
- **Updated `locked-selection.test.ts` / `overlay-dialogue-integration.test.ts`** — same structure as Step 2, only import paths and `vi.mock` targets repointed to `font-resolver`/`resolveFontFromSelection`.
- **Manual checklist (final task)** — clean single-font selection (high confidence match); selection spanning two differently-styled runs (match if one dominates ≥60%, else no-match); selection over a font not in `KNOWN_FONTS` (no-match/unrecognized); selection over non-text — image or empty page area (no-match/no-text); confirm the spinner is now briefly but reliably visible (the `MIN_SCAN_DURATION_MS` floor) rather than flashing instantly; confirm dispose-during-loading (Esc/panel-close/icon-toggle-off, established in Step 2) still works correctly using this restored manual-testing window.

## Out of scope for this spec

Real backend API calls (Step 4), real enrollment submission (Step 5), multi-source ranking/voting logic beyond reusing the existing `ScanSource` shape (Step 6), saved-library persistence (Step 7), tier gating (Step 8), theme toggle UI (still deferred from Step 1), `reason`-specific no-match copy and confidence-label wording (both explicitly noted above as deferred polish, not built now).
