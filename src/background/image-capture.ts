import type { Rect } from '../shared/selection-box';
import type { CaptureResponse } from '../shared/capture-messages';

export const BLACKNESS_THRESHOLD = 12;
export const BLACKNESS_SAMPLE_GRID = 5;

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cssRectToPixelRect(rect: Rect, devicePixelRatio: number): PixelRect {
  return {
    x: Math.round(rect.x * devicePixelRatio),
    y: Math.round(rect.y * devicePixelRatio),
    width: Math.round(rect.width * devicePixelRatio),
    height: Math.round(rect.height * devicePixelRatio),
  };
}

export interface SimpleImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Mirrors dom-sampling.ts's generateSamplePoints (0.1-0.9 inset, same
// gridSize-1 denominator) for a raster pixel grid instead of a CSS rect.
function generatePixelGridPoints(
  width: number,
  height: number,
  gridSize: number,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let col = 0; col < gridSize; col++) {
    for (let row = 0; row < gridSize; row++) {
      const fx = 0.1 + (0.8 * col) / (gridSize - 1);
      const fy = 0.1 + (0.8 * row) / (gridSize - 1);
      points.push({
        x: Math.min(width - 1, Math.floor(fx * width)),
        y: Math.min(height - 1, Math.floor(fy * height)),
      });
    }
  }
  return points;
}

// DRM-protected video renders as solid black in a captureVisibleTab
// screenshot (a documented Chrome/EME behavior) — not an arbitrary color.
// Checking specifically for near-black, rather than "any uniform color",
// avoids flagging a legitimately capturable solid-color image region (a
// plain banner, an empty margin) as blocked. Known, accepted limitation: a
// genuinely solid-black image region would also trigger this.
export function isSuspiciouslyBlack(image: SimpleImageData): boolean {
  if (image.width <= 0 || image.height <= 0) return false;

  const points = generatePixelGridPoints(image.width, image.height, BLACKNESS_SAMPLE_GRID);
  for (const { x, y } of points) {
    const idx = (y * image.width + x) * 4;
    const r = image.data[idx];
    const g = image.data[idx + 1];
    const b = image.data[idx + 2];
    if (r > BLACKNESS_THRESHOLD || g > BLACKNESS_THRESHOLD || b > BLACKNESS_THRESHOLD) {
      return false;
    }
  }
  return true;
}

// The one function in this file that touches real browser capture/canvas
// APIs (chrome.tabs.captureVisibleTab, createImageBitmap, OffscreenCanvas).
// jsdom implements none of these — no layout engine, no image decoding — so
// this cannot be meaningfully unit-tested. Verified only by the manual
// Chrome checklist (a later task in this plan), the same treatment an
// earlier sub-project gave dom-sampling.ts's readFontAtPoint.
export async function captureAndCropSelection(
  windowId: number,
  rect: Rect,
  devicePixelRatio: number,
): Promise<CaptureResponse> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const captureRes = await fetch(dataUrl);
    const captureBlob = await captureRes.blob();
    const bitmap = await createImageBitmap(captureBlob);

    const pixelRect = cssRectToPixelRect(rect, devicePixelRatio);
    if (pixelRect.width <= 0 || pixelRect.height <= 0) {
      return { status: 'error', message: 'Selection is too small to capture' };
    }

    const canvas = new OffscreenCanvas(pixelRect.width, pixelRect.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { status: 'error', message: 'Canvas context unavailable' };
    }

    ctx.drawImage(
      bitmap,
      pixelRect.x,
      pixelRect.y,
      pixelRect.width,
      pixelRect.height,
      0,
      0,
      pixelRect.width,
      pixelRect.height,
    );

    const imageData = ctx.getImageData(0, 0, pixelRect.width, pixelRect.height);
    if (isSuspiciouslyBlack(imageData)) {
      return { status: 'blocked' };
    }

    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    return { status: 'captured', blob: croppedBlob };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Unknown capture error' };
  }
}
