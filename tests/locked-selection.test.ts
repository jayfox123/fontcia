import { describe, it, expect, vi } from 'vitest';
import { renderLockedSelection } from '../src/content/locked-selection';
import type { ScanResult } from '../src/content/scan-types';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('renderLockedSelection', () => {
  it('renders a box positioned to the rect', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { box } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());

    expect(box.className).toBe('fontcia-box');
    expect(box.style.left).toBe('10px');
    expect(box.style.top).toBe('20px');
    expect(box.style.width).toBe('100px');
    expect(box.style.height).toBe('30px');
    expect(container.contains(box)).toBe(true);
  });

  it('renders a panel underneath the box with a notch and close button', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());

    expect(panel.className).toBe('fontcia-panel');
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('58px'); // rect.y + rect.height + 8px gap
    expect(panel.querySelector('.fontcia-notch')).not.toBeNull();
    expect(panel.querySelector('.fontcia-panel-close')).not.toBeNull();
    expect(container.contains(panel)).toBe(true);
  });

  it('calls onDismiss when the close button is clicked', () => {
    const container = document.createElement('div');
    const onDismiss = vi.fn();

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 100, height: 30 }, onDismiss, vi.fn());
    const closeBtn = panel.querySelector('.fontcia-panel-close') as HTMLElement;
    closeBtn.click();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows the ready state with a Scan button initially', () => {
    const container = document.createElement('div');

    const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn());

    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(scanBtn.textContent).toBe('Scan');
  });

  it('transitions ready -> loading -> result when Scan is clicked and the mock resolves to a match', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    const scanBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    scanBtn.click();

    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();

    deferred.resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');
  });

  it('transitions ready -> loading -> no-match when the mock resolves to no-match', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 40, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();

    deferred.resolve({ status: 'no-match' });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-no-match-message')).not.toBeNull();
  });

  it('toggles saved state on the result view when Save is clicked', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

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

    const saveBtn = panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');

    saveBtn.click();
    expect((panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).textContent).toBe('★ Saved');
  });

  it('calls onRestart when New scan is clicked in the result state', async () => {
    const container = document.createElement('div');
    const onRestart = vi.fn();
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] }),
    );

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      onRestart,
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const newScanBtn = panel.querySelector('.fontcia-btn-secondary') as HTMLButtonElement;
    newScanBtn.click();

    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('does not render a result if dispose() is called before the mock resolves', async () => {
    const container = document.createElement('div');
    const deferred = createDeferred<ScanResult>();
    const scanFn = vi.fn(() => deferred.promise);

    const { panel, dispose } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    dispose();

    deferred.resolve({ status: 'match', fontName: 'Inter', confidence: 92, sources: [] });
    await deferred.promise;

    expect(panel.querySelector('.fontcia-result-font')).toBeNull();
    expect(panel.querySelector('.fontcia-spinner')).not.toBeNull();
  });

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
});
