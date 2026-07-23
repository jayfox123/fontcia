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

import { armSelectionMode, dismissSelection } from '../src/content/overlay';
import { isSelectionActive, clearSelectionActive } from '../src/shared/session-state';

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

    await new Promise((resolve) => setTimeout(resolve, 150));

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

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Proves the mock actually intercepted resolveFontFromSelection rather than
    // the real (jsdom-incompatible) resolver silently running, throwing, and
    // falling into the no-match state instead — which would also render a
    // '.fontcia-btn-secondary' button with "New scan" text, making the
    // assertions below pass regardless of whether the mock is even wired up.
    expect(surface.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');

    const newScanBtn = Array.from(surface.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;

    // Force the flag false immediately before restarting. restartSelection()
    // deliberately never clears it itself (see overlay.ts), so by the time we
    // get here it would already read true regardless of whether the restart
    // path works — asserting `true` afterward would pass even if
    // armSelectionMode's re-mark were completely removed. Clearing it here
    // first means the final assertion only passes if the restart path
    // actually re-marks the tab active, not because it was never touched.
    await clearSelectionActive(1);

    newScanBtn.click();

    const newHost = document.getElementById('fontcia-overlay-host');
    expect(newHost).not.toBeNull();

    const newSurface = newHost?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;
    expect(newSurface.style.cursor).toBe('crosshair');
    expect(newSurface.querySelector('.fontcia-box')).toBeNull();

    await expect(isSelectionActive(1)).resolves.toBe(true);
  });
});
