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
