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
          }, 15);
        }),
    ),
  };
});

import { armSelectionMode, dismissSelection } from '../src/content/overlay';
import { isSelectionActive } from '../src/shared/session-state';

function dispatchMouse(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

afterEach(() => {
  dismissSelection();
  document.body.innerHTML = '';
});

describe('dispose on real dismiss paths cancels an in-flight scan', () => {
  it('does not render a result if Escape dismisses the selection while loading', async () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 200, 60);

    // Keep a direct reference to the panel *before* dismissing. This matters:
    // once Escape tears down the overlay, hostEl is removed from `document`,
    // so a `document.querySelector(...)` assertion would pass trivially
    // whether or not dispose() actually fired — it wouldn't prove anything.
    // Checking this retained (now-detached) node's own children directly is
    // what actually proves the pending scan's resolution never touched it.
    const panel = surface.querySelector('.fontcia-panel') as Element;
    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
    expect(panel.querySelector('.fontcia-result-font')).toBeNull();
    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();
  });
});

describe('restartSelection via New scan', () => {
  it('re-arms crosshair mode with a fresh overlay after a match', async () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 200, 60);

    const scanBtn = surface.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 25));

    const newScanBtn = Array.from(surface.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;
    newScanBtn.click();

    const newHost = document.getElementById('fontcia-overlay-host');
    expect(newHost).not.toBeNull();

    const newSurface = newHost?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;
    expect(newSurface.style.cursor).toBe('crosshair');
    expect(newSurface.querySelector('.fontcia-box')).toBeNull();

    await expect(isSelectionActive(1)).resolves.toBe(true);
  });
});
