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
