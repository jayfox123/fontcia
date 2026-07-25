import { describe, it, expect } from 'vitest';
import { cssRectToPixelRect, isSuspiciouslyBlack, BLACKNESS_THRESHOLD } from '../src/background/image-capture';

describe('cssRectToPixelRect', () => {
  it('scales a CSS rect by the device pixel ratio', () => {
    const result = cssRectToPixelRect({ x: 10, y: 20, width: 100, height: 50 }, 2);
    expect(result).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });

  it('rounds fractional results to whole pixels', () => {
    const result = cssRectToPixelRect({ x: 10.4, y: 20.6, width: 100.5, height: 50.5 }, 1.5);
    expect(result).toEqual({ x: 16, y: 31, width: 151, height: 76 });
  });

  it('handles a devicePixelRatio of 1 as a no-op scale', () => {
    const result = cssRectToPixelRect({ x: 5, y: 5, width: 40, height: 30 }, 1);
    expect(result).toEqual({ x: 5, y: 5, width: 40, height: 30 });
  });
});

describe('isSuspiciouslyBlack', () => {
  function makeUniformImage(
    width: number,
    height: number,
    r: number,
    g: number,
    b: number,
  ): { data: Uint8ClampedArray; width: number; height: number } {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    return { data, width, height };
  }

  it('returns true for a fully black image', () => {
    expect(isSuspiciouslyBlack(makeUniformImage(20, 20, 0, 0, 0))).toBe(true);
  });

  it('returns true for an image at exactly the blackness threshold', () => {
    expect(
      isSuspiciouslyBlack(makeUniformImage(20, 20, BLACKNESS_THRESHOLD, BLACKNESS_THRESHOLD, BLACKNESS_THRESHOLD)),
    ).toBe(true);
  });

  it('returns false for an image one shade above the threshold', () => {
    expect(isSuspiciouslyBlack(makeUniformImage(20, 20, BLACKNESS_THRESHOLD + 1, 0, 0))).toBe(false);
  });

  it('returns false for a uniform non-black color', () => {
    expect(isSuspiciouslyBlack(makeUniformImage(20, 20, 200, 100, 50))).toBe(false);
  });

  it('returns false for an image with visible content (not uniform)', () => {
    const image = makeUniformImage(20, 20, 0, 0, 0);
    // (10, 10) is one of the 5x5 grid's sampled points for a 20x20 image
    // (col=2, row=2 maps to fx=fy=0.5 -> floor(0.5*20)=10) — punching a
    // bright pixel there proves the sampler actually notices it.
    const idx = (10 * 20 + 10) * 4;
    image.data[idx] = 255;
    image.data[idx + 1] = 255;
    image.data[idx + 2] = 255;
    expect(isSuspiciouslyBlack(image)).toBe(false);
  });

  it('returns false for a zero-size image', () => {
    expect(isSuspiciouslyBlack({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBe(false);
  });
});
