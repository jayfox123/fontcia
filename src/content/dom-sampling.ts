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
