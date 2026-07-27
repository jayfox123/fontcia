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

  it('returns no-match/unrecognized with the detected font-family and confidence when the winning font is not in the known-fonts table', () => {
    const result = resolveFromReadings([unknown, unknown, unknown]);
    expect(result).toEqual({
      status: 'no-match',
      reason: 'unrecognized',
      detectedFontFamily: 'SomeUnknownFont',
      detectedConfidence: 100,
    });
  });

  it('carries the correct partial confidence for an unrecognized font that only reaches a partial majority', () => {
    const otherUnknown: FontReading = { fontFamily: 'AnotherUnknownFont', fontWeight: '400', fontStyle: 'normal' };
    // 3 of 4 = 75%, above the 60% threshold, still unrecognized
    const result = resolveFromReadings([unknown, unknown, unknown, otherUnknown]);
    expect(result.status).toBe('no-match');
    if (result.status === 'no-match') {
      expect(result.detectedFontFamily).toBe('SomeUnknownFont');
      expect(result.detectedConfidence).toBe(75);
    }
  });

  it('treats a boundary exactly at the majority threshold as passing', () => {
    // 3 of 5 = 60%, exactly at MAJORITY_THRESHOLD
    expect(MAJORITY_THRESHOLD).toBe(0.6);
    const result = resolveFromReadings([inter, inter, inter, roboto, roboto]);
    expect(result.status).toBe('match');
  });
});
