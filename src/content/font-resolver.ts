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
    return {
      status: 'no-match',
      reason: 'unrecognized',
      detectedFontFamily: winner!.reading.fontFamily,
      detectedConfidence: Math.round(share * 100),
    };
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
  // sampleRect/resolveFromReadings must run *inside* the executor, not before
  // it: computing the result first and only then constructing the Promise
  // means a throw from the real DOM APIs (caretRangeFromPoint,
  // elementsFromPoint, getComputedStyle — none of which are wrapped in a
  // try/catch) would escape as a synchronous exception out of this function
  // rather than a rejected promise. locked-selection.ts's handleScan relies
  // on scanFn(rect) always returning a promise it can attach .catch() to —
  // a synchronous throw here would bypass that entirely.
  return new Promise((resolve) => {
    const result = resolveFromReadings(sampleRect(rect));
    setTimeout(() => resolve(result), MIN_SCAN_DURATION_MS);
  });
}
