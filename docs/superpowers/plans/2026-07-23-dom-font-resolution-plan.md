# DOM Font-Resolution Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `mock-scan.ts`'s `rect.width`-based determinism with real font detection — sample the DOM under the locked selection rectangle, resolve computed font signatures, majority-vote a dominant font, look it up against a bundled known-fonts table, and produce a real `ScanResult` for the existing dialogue UI.

**Architecture:** Four new modules split by testability: `scan-types.ts` (pure types), `dom-sampling.ts` (a pure grid-math half, fully tested, plus a browser-only hit-testing half that jsdom cannot simulate), `known-fonts.ts` (pure seed data + lookup, fully tested), `font-resolver.ts` (pure majority-vote decision logic, fully tested, plus a composed real-world default with a perceived-loading floor). `mock-scan.ts` and its test are deleted outright once every consumer is repointed.

**Tech Stack:** Manifest V3, vanilla TypeScript (no framework), Vitest + jsdom for unit tests.

---

## File Structure

- `src/content/scan-types.ts` (new) — `ScanSource`/`MatchResult`/`NoMatchResult`/`ScanResult`, moved out of `mock-scan.ts`
- `src/content/dom-sampling.ts` (new) — `generateSamplePoints` (pure), `readFontAtPoint`/`sampleRect` (browser-only)
- `src/content/known-fonts.ts` (new) — `KNOWN_FONTS` seed data, `findKnownFont` lookup
- `src/content/font-resolver.ts` (new) — `resolveFromReadings` (pure), `resolveFontFromSelection` (composed, real default `scanFn`)
- `src/content/locked-selection.ts` (modified) — `scanFn` default swaps to `resolveFontFromSelection`; type imports move to `scan-types.ts`; `handleScan` gains a `.catch`
- `src/content/scan-dialogue.ts` (modified) — type import moves to `scan-types.ts`
- `tests/dom-sampling.test.ts` (new), `tests/known-fonts.test.ts` (new), `tests/font-resolver.test.ts` (new)
- `tests/locked-selection.test.ts`, `tests/scan-dialogue.test.ts`, `tests/overlay-dialogue-integration.test.ts` (all modified — import/mock-target updates)
- `src/content/mock-scan.ts`, `tests/mock-scan.test.ts` (deleted)

---

### Task 1: Scan Result Types

**Files:**
- Create: `src/content/scan-types.ts`

- [ ] **Step 1: Create the file**

`src/content/scan-types.ts`:

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

This is a pure type-only file (no runtime logic), so there's no dedicated test — consistent with how `Point`/`Rect` in `src/shared/selection-box.ts` were never unit-tested as types themselves, only the functions using them.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors (nothing imports this file yet, so this just confirms the syntax is valid).

- [ ] **Step 3: Commit**

```bash
git add src/content/scan-types.ts
git commit -m "feat: extract ScanResult type contract out of mock-scan.ts"
```

---

### Task 2: DOM Sampling

**Files:**
- Create: `src/content/dom-sampling.ts`
- Test: `tests/dom-sampling.test.ts`

- [ ] **Step 1: Write the failing test for the pure grid function**

`tests/dom-sampling.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateSamplePoints, SAMPLE_GRID_SIZE } from '../src/content/dom-sampling';

describe('generateSamplePoints', () => {
  const rect = { x: 100, y: 200, width: 400, height: 100 };

  it('generates exactly SAMPLE_GRID_SIZE squared points', () => {
    const points = generateSamplePoints(rect);
    expect(points.length).toBe(SAMPLE_GRID_SIZE * SAMPLE_GRID_SIZE);
  });

  it('keeps every point within a 10%-90% inset of the rect', () => {
    const points = generateSamplePoints(rect);
    const minX = rect.x + rect.width * 0.1;
    const maxX = rect.x + rect.width * 0.9;
    const minY = rect.y + rect.height * 0.1;
    const maxY = rect.y + rect.height * 0.9;

    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(minX - 1e-9);
      expect(point.x).toBeLessThanOrEqual(maxX + 1e-9);
      expect(point.y).toBeGreaterThanOrEqual(minY - 1e-9);
      expect(point.y).toBeLessThanOrEqual(maxY + 1e-9);
    }
  });

  it('includes the exact corners of the inset bounds', () => {
    const points = generateSamplePoints(rect);
    const minX = rect.x + rect.width * 0.1;
    const maxX = rect.x + rect.width * 0.9;
    const minY = rect.y + rect.height * 0.1;
    const maxY = rect.y + rect.height * 0.9;

    const hasPoint = (x: number, y: number) =>
      points.some((p) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);

    expect(hasPoint(minX, minY)).toBe(true);
    expect(hasPoint(maxX, maxY)).toBe(true);
  });

  it('produces distinct points for a reasonably sized rect', () => {
    const points = generateSamplePoints(rect);
    const uniqueKeys = new Set(points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    expect(uniqueKeys.size).toBe(points.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dom-sampling.test.ts`
Expected: FAIL — `Cannot find module '../src/content/dom-sampling'`

- [ ] **Step 3: Write the full implementation**

`src/content/dom-sampling.ts`:

```ts
import type { Point, Rect } from '../shared/selection-box';

export const SAMPLE_GRID_SIZE = 5;

export function generateSamplePoints(rect: Rect): Point[] {
  const points: Point[] = [];
  for (let col = 0; col < SAMPLE_GRID_SIZE; col++) {
    for (let row = 0; row < SAMPLE_GRID_SIZE; row++) {
      const fx = 0.1 + (0.8 * col) / (SAMPLE_GRID_SIZE - 1);
      const fy = 0.1 + (0.8 * row) / (SAMPLE_GRID_SIZE - 1);
      points.push({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
    }
  }
  return points;
}

export interface FontReading {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
}

function readComputedFont(el: Element): FontReading {
  const style = getComputedStyle(el);
  return {
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
  };
}

// The one function in this file that touches real browser hit-testing APIs.
// jsdom has no layout engine — it doesn't implement caretRangeFromPoint at
// all, and elementsFromPoint always returns an empty list — so this cannot
// be meaningfully unit-tested. Verified only by the manual Chrome checklist
// (this sub-project's final task), the same treatment Step 1 gave crosshair
// rendering and click-through behavior.
export function readFontAtPoint(point: Point): FontReading | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(point.x, point.y);
    const node = range?.startContainer;
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
    if (el) {
      return readComputedFont(el);
    }
  }

  const elements = document.elementsFromPoint(point.x, point.y);
  const textEl = elements.find((el) => (el.textContent ?? '').trim().length > 0);
  return textEl ? readComputedFont(textEl) : null;
}

export function sampleRect(rect: Rect): FontReading[] {
  return generateSamplePoints(rect)
    .map(readFontAtPoint)
    .filter((reading): reading is FontReading => reading !== null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dom-sampling.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content/dom-sampling.ts tests/dom-sampling.test.ts
git commit -m "feat: add grid-based DOM sampling for font resolution"
```

---

### Task 3: Known Fonts Table

**Files:**
- Create: `src/content/known-fonts.ts`
- Test: `tests/known-fonts.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/known-fonts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findKnownFont, KNOWN_FONTS } from '../src/content/known-fonts';

describe('findKnownFont', () => {
  it('matches an exact, unquoted family name', () => {
    const found = findKnownFont('Inter');
    expect(found?.name).toBe('Inter');
  });

  it('matches case-insensitively', () => {
    const found = findKnownFont('INTER');
    expect(found?.name).toBe('Inter');
  });

  it('matches a quoted family name inside a full stack', () => {
    const found = findKnownFont('"Roboto", -apple-system, sans-serif');
    expect(found?.name).toBe('Roboto');
  });

  it('picks the first matching entry in stack order', () => {
    const found = findKnownFont('SomeUnknownFont, Lato, Roboto');
    expect(found?.name).toBe('Lato');
  });

  it('returns null when nothing in the stack is known', () => {
    const found = findKnownFont('SomeUnknownFont, AnotherUnknownFont');
    expect(found).toBeNull();
  });

  it('seeds exactly the ten expected fonts', () => {
    expect(KNOWN_FONTS.map((f) => f.name)).toEqual([
      'Inter',
      'Roboto',
      'Open Sans',
      'Lato',
      'Montserrat',
      'Poppins',
      'Nunito',
      'Source Sans Pro',
      'Playfair Display',
      'Merriweather',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/known-fonts.test.ts`
Expected: FAIL — `Cannot find module '../src/content/known-fonts'`

- [ ] **Step 3: Write the full implementation**

`src/content/known-fonts.ts`:

```ts
import type { ScanSource } from './scan-types';

export interface KnownFont {
  name: string;
  matchKeys: string[];
  license: string;
  sources: ScanSource[];
}

function googleFontsSource(slug: string, votes: number): ScanSource {
  return { url: `https://fonts.google.com/specimen/${slug}`, label: 'Google Fonts', votes };
}

const OFL = 'SIL Open Font License 1.1';

export const KNOWN_FONTS: KnownFont[] = [
  { name: 'Inter', matchKeys: ['inter'], license: OFL, sources: [googleFontsSource('Inter', 1)] },
  { name: 'Roboto', matchKeys: ['roboto'], license: 'Apache License 2.0', sources: [googleFontsSource('Roboto', 1)] },
  { name: 'Open Sans', matchKeys: ['open sans'], license: OFL, sources: [googleFontsSource('Open+Sans', 1)] },
  { name: 'Lato', matchKeys: ['lato'], license: OFL, sources: [googleFontsSource('Lato', 1)] },
  { name: 'Montserrat', matchKeys: ['montserrat'], license: OFL, sources: [googleFontsSource('Montserrat', 1)] },
  { name: 'Poppins', matchKeys: ['poppins'], license: OFL, sources: [googleFontsSource('Poppins', 1)] },
  { name: 'Nunito', matchKeys: ['nunito'], license: OFL, sources: [googleFontsSource('Nunito', 1)] },
  {
    name: 'Source Sans Pro',
    matchKeys: ['source sans pro', 'source sans 3'],
    license: OFL,
    sources: [googleFontsSource('Source+Sans+Pro', 1)],
  },
  {
    name: 'Playfair Display',
    matchKeys: ['playfair display'],
    license: OFL,
    sources: [googleFontsSource('Playfair+Display', 1)],
  },
  { name: 'Merriweather', matchKeys: ['merriweather'], license: OFL, sources: [googleFontsSource('Merriweather', 1)] },
];

export function findKnownFont(fontFamilyStack: string): KnownFont | null {
  const candidates = fontFamilyStack
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, '').toLowerCase());

  for (const candidate of candidates) {
    const found = KNOWN_FONTS.find((font) => font.matchKeys.includes(candidate));
    if (found) return found;
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/known-fonts.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/content/known-fonts.ts tests/known-fonts.test.ts
git commit -m "feat: add seed known-fonts table with stack-order lookup"
```

---

### Task 4: Font Resolver

**Files:**
- Create: `src/content/font-resolver.ts`
- Test: `tests/font-resolver.test.ts`

- [ ] **Step 1: Write the failing test for the pure decision logic**

`tests/font-resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveFromReadings, MAJORITY_THRESHOLD } from '../src/content/font-resolver';
import type { FontReading } from '../src/content/dom-sampling';

const inter: FontReading = { fontFamily: 'Inter, sans-serif', fontWeight: '400', fontStyle: 'normal' };
const roboto: FontReading = { fontFamily: 'Roboto, sans-serif', fontWeight: '400', fontStyle: 'normal' };
const unknown: FontReading = { fontFamily: 'SomeUnknownFont', fontWeight: '400', fontStyle: 'normal' };

describe('resolveFromReadings', () => {
  it('returns no-match/no-text for an empty reading list', () => {
    expect(resolveFromReadings([])).toEqual({ status: 'no-match', reason: 'no-text' });
  });

  it('returns a match with 100% confidence when all readings agree on a known font', () => {
    const result = resolveFromReadings([inter, inter, inter, inter]);
    expect(result).toEqual({
      status: 'match',
      fontName: 'Inter',
      confidence: 100,
      sources: expect.any(Array),
    });
  });

  it('returns a match with confidence equal to the winning share', () => {
    // 3 of 4 = 75%, above the 60% threshold
    const result = resolveFromReadings([inter, inter, inter, roboto]);
    expect(result.status).toBe('match');
    if (result.status === 'match') {
      expect(result.fontName).toBe('Inter');
      expect(result.confidence).toBe(75);
    }
  });

  it('returns no-match/mixed when no signature reaches the majority threshold', () => {
    // 2 of 4 = 50%, below the 60% threshold
    const result = resolveFromReadings([inter, inter, roboto, roboto]);
    expect(result).toEqual({ status: 'no-match', reason: 'mixed' });
  });

  it('returns no-match/unrecognized when the winning font is not in the known-fonts table', () => {
    const result = resolveFromReadings([unknown, unknown, unknown]);
    expect(result).toEqual({ status: 'no-match', reason: 'unrecognized' });
  });

  it('treats a boundary exactly at the majority threshold as passing', () => {
    // 3 of 5 = 60%, exactly at MAJORITY_THRESHOLD
    expect(MAJORITY_THRESHOLD).toBe(0.6);
    const result = resolveFromReadings([inter, inter, inter, roboto, roboto]);
    expect(result.status).toBe('match');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/font-resolver.test.ts`
Expected: FAIL — `Cannot find module '../src/content/font-resolver'`

- [ ] **Step 3: Write the full implementation**

`src/content/font-resolver.ts`:

```ts
import type { Rect } from '../shared/selection-box';
import type { ScanResult, MatchResult } from './scan-types';
import { sampleRect, type FontReading } from './dom-sampling';
import { findKnownFont } from './known-fonts';

export const MAJORITY_THRESHOLD = 0.6;
export const MIN_SCAN_DURATION_MS = 175;

function signatureKey(reading: FontReading): string {
  return `${reading.fontFamily}|${reading.fontWeight}|${reading.fontStyle}`;
}

export function resolveFromReadings(readings: FontReading[]): ScanResult {
  if (readings.length === 0) {
    return { status: 'no-match', reason: 'no-text' };
  }

  const counts = new Map<string, { reading: FontReading; count: number }>();
  for (const reading of readings) {
    const key = signatureKey(reading);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { reading, count: 1 });
    }
  }

  let winner: { reading: FontReading; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!winner || entry.count > winner.count) {
      winner = entry;
    }
  }

  const share = winner!.count / readings.length;
  if (share < MAJORITY_THRESHOLD) {
    return { status: 'no-match', reason: 'mixed' };
  }

  const known = findKnownFont(winner!.reading.fontFamily);
  if (!known) {
    return { status: 'no-match', reason: 'unrecognized' };
  }

  const result: MatchResult = {
    status: 'match',
    fontName: known.name,
    confidence: Math.round(share * 100),
    sources: known.sources,
  };
  return result;
}

// Not independently unit-tested: this composes sampleRect, the real-browser
// hit-testing function from dom-sampling.ts that jsdom cannot simulate.
// resolveFromReadings above (the actual decision logic) is fully covered;
// this is verified end-to-end only by the manual Chrome checklist.
export function resolveFontFromSelection(rect: Rect): Promise<ScanResult> {
  const result = resolveFromReadings(sampleRect(rect));
  return new Promise((resolve) => {
    setTimeout(() => resolve(result), MIN_SCAN_DURATION_MS);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/font-resolver.test.ts`
Expected: PASS — 6 tests passed

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content/font-resolver.ts tests/font-resolver.test.ts
git commit -m "feat: add majority-vote font resolution with perceived-loading floor"
```

---

### Task 5: Wire Into `locked-selection.ts`

**Files:**
- Modify: `src/content/locked-selection.ts`
- Modify: `tests/locked-selection.test.ts`

- [ ] **Step 1: Write the failing test for the new error-handling behavior**

Add this test inside the existing `describe('renderLockedSelection', ...)` block in `tests/locked-selection.test.ts`, anywhere after the other tests (e.g. at the end, before the closing `});`):

```ts
  it('falls back to the no-match state if the scan promise rejects', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.reject(new Error('boom')));

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

    expect(panel.querySelector('.fontcia-no-match-message')).not.toBeNull();
  });
```

Also change the type import at the top of the file from:

```ts
import type { ScanResult } from '../src/content/mock-scan';
```

to:

```ts
import type { ScanResult } from '../src/content/scan-types';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — either a module-resolution error (since `scan-types.ts` isn't imported by `locked-selection.ts` yet, so `mock-scan.ts` is still exporting the real `ScanResult` the rest of the suite uses) or the new rejection test fails because `handleScan` has no `.catch` yet and the panel is left showing the loading spinner forever, never rendering `.fontcia-no-match-message`

- [ ] **Step 3: Update `src/content/locked-selection.ts`**

Change the top of the file from:

```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './mock-scan';
import { mockScan } from './mock-scan';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from './scan-dialogue';
```

to:

```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './scan-types';
import { resolveFontFromSelection } from './font-resolver';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from './scan-dialogue';
```

Change the `scanFn` default parameter from:

```ts
  scanFn: (rect: Rect) => Promise<ScanResult> = mockScan,
```

to:

```ts
  scanFn: (rect: Rect) => Promise<ScanResult> = resolveFontFromSelection,
```

Change `handleScan` from:

```ts
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
```

to:

```ts
  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
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
        if (disposed) return;
        console.error('fontCIA: font resolution failed', error);
        renderNoMatchState(body, onRestart);
      });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — 10 tests passed (9 pre-existing + 1 new)

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: wire real font resolution into locked-selection, add scan-failure fallback"
```

---

### Task 6: Wire Into `scan-dialogue.ts`

**Files:**
- Modify: `src/content/scan-dialogue.ts`
- Modify: `tests/scan-dialogue.test.ts`

- [ ] **Step 1: Update the type imports**

In `src/content/scan-dialogue.ts`, change:

```ts
import type { MatchResult } from './mock-scan';
```

to:

```ts
import type { MatchResult } from './scan-types';
```

In `tests/scan-dialogue.test.ts`, change:

```ts
import type { MatchResult } from '../src/content/mock-scan';
```

to:

```ts
import type { MatchResult } from '../src/content/scan-types';
```

- [ ] **Step 2: Run the test suite to verify nothing broke**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — 9 tests passed (unchanged count; this is a type-only import swap, no behavior changed)

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/content/scan-dialogue.ts tests/scan-dialogue.test.ts
git commit -m "chore: point scan-dialogue's type import at scan-types.ts"
```

---

### Task 7: Repoint the End-to-End Integration Test

**Files:**
- Modify: `tests/overlay-dialogue-integration.test.ts`

The existing file mocks `mock-scan.ts`'s `mockScan` export and branches its canned response on `rect.width` (mirroring the old mock's own logic). Since `locked-selection.ts`'s default `scanFn` now points at `font-resolver.ts`'s `resolveFontFromSelection`, this test needs to mock that module instead. Both existing tests in this file only ever exercise a wide rect that resolved to `match` under the old width-based mock, so the replacement mock can simplify to always resolving `match` — no branching needed.

- [ ] **Step 1: Replace the top of the file**

Change the imports and `vi.mock` block from:

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
          }, 20);
        }),
    ),
  };
});
```

to:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ScanResult } from '../src/content/scan-types';

vi.mock('../src/content/font-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/content/font-resolver')>();
  return {
    ...actual,
    resolveFontFromSelection: vi.fn(
      () =>
        new Promise<ScanResult>((resolve) => {
          setTimeout(() => {
            resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
          }, 20);
        }),
    ),
  };
});
```

Leave the rest of the file (the `armSelectionMode`/`dismissSelection`/`isSelectionActive`/`clearSelectionActive` imports, `dispatchMouse`, `afterEach`, and both `describe` blocks) exactly as-is — nothing else in this file changes.

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/overlay-dialogue-integration.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 4: Commit**

```bash
git add tests/overlay-dialogue-integration.test.ts
git commit -m "test: repoint end-to-end dialogue test at font-resolver instead of mock-scan"
```

---

### Task 8: Delete the Mock and Verify

**Files:**
- Delete: `src/content/mock-scan.ts`
- Delete: `tests/mock-scan.test.ts`

Every consumer was repointed in Tasks 5–7; nothing should still reference these two files.

- [ ] **Step 1: Confirm nothing still references mock-scan**

Run: `grep -rn "mock-scan" src tests --include="*.ts"`
Expected: no output (no matches).

If this produces any output, stop and fix that reference before proceeding — deleting the files at that point would break the build.

- [ ] **Step 2: Delete the files**

```bash
git rm src/content/mock-scan.ts tests/mock-scan.test.ts
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc --noEmit` clean; all test files pass (dom-sampling, known-fonts, font-resolver, session-state, selection-box, service-worker, scan-dialogue, locked-selection, overlay, overlay-dialogue-integration, overlay-integration).

- [ ] **Step 4: Verify the production build**

Run: `npm run build`
Expected: creates `dist/background/service-worker.js`, `dist/content/overlay.js`, `dist/manifest.json` with no errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: delete mock-scan.ts now that every consumer uses font-resolver.ts"
```

---

### Task 9: Manual Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Load the rebuilt extension**

Load `dist/` as an unpacked extension in `chrome://extensions` (reload if it was already loaded from a prior sub-project).

- [ ] **Step 2: Manual checklist**

- **Clean single-font selection:** draw a box tightly around a run of text set in one of the ten seeded fonts (e.g. find a page using Roboto or Open Sans, or use a test page styled with one of the seed fonts) — confirm the result state shows the correct font name and a high confidence percentage (close to 100%).
- **Mixed-font selection:** draw a box spanning two visibly different fonts (e.g. a heading in one font overlapping body text in another) roughly evenly — confirm it resolves to no-match rather than silently picking one.
- **Unlisted font:** draw a box around text in a font not in the seed list (most default system fonts, or a page using a Google Font outside the ten seeded) — confirm no-match.
- **Non-text selection:** draw a box entirely over an image or empty whitespace — confirm no-match (no crash, no stuck loading state).
- **Perceptible loading:** confirm the spinner is now briefly but reliably visible on every scan (the `MIN_SCAN_DURATION_MS` floor), rather than flashing instantly or not appearing at all.
- **Dispose-during-loading still works:** click Scan, then immediately press Escape before the ~175ms floor elapses — confirm no result flashes in afterward. This is the manual-testing window the floor was specifically added to preserve.
- **New scan and Save still work** exactly as in Step 2 (this sub-project didn't touch that wiring, but worth a quick smoke check since the data flowing through it is now real).

- [ ] **Step 3: Record results**

If all checks pass, this sub-project is complete. If a fix is required, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix.

---

## Self-Review Notes

- **Spec coverage:** grid sampling (`caretRangeFromPoint` primary, `elementsFromPoint` fallback) → Task 2; majority-vote resolution at 60% → Task 4; known-fonts table reusing `ScanSource`, seeded with 10 Google Fonts → Task 3; confidence as sample-agreement percentage → Task 4 (`Math.round(share * 100)`); `MIN_SCAN_DURATION_MS` floor scoped to the real resolver only, not the generic `scanFn` seam → Task 4; `.catch` error handling in `handleScan` → Task 5; full replacement (not parallel) of `mock-scan.ts` → Task 8; type contract moved to `scan-types.ts` → Task 1; all three existing test files repointed → Tasks 5–7; manual-only verification for browser-only hit-testing → Task 9. All spec sections are covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `ScanResult`/`MatchResult`/`NoMatchResult` (Task 1) are imported by identical names in `known-fonts.ts` (Task 3), `font-resolver.ts` (Task 4), `locked-selection.ts` and its test (Task 5), `scan-dialogue.ts` and its test (Task 6), and `overlay-dialogue-integration.test.ts` (Task 7). `FontReading` (Task 2) is imported by identical name and shape in `font-resolver.ts` (Task 4) and its test. `resolveFontFromSelection`'s signature (`(rect: Rect) => Promise<ScanResult>`, Task 4) matches exactly what `locked-selection.ts`'s `scanFn` parameter type already expects (Task 5) — no signature drift. `findKnownFont`'s return type (`KnownFont | null`, Task 3) matches how `font-resolver.ts` consumes it (Task 4, `known.name`/`known.sources`).
