import { describe, it, expect, afterEach } from 'vitest';
import { armSelectionMode, dismissSelection } from '../src/content/overlay';
import { isSelectionActive, markSelectionActive } from '../src/shared/session-state';

afterEach(() => {
  dismissSelection();
  document.body.innerHTML = '';
});

describe('armSelectionMode / dismissSelection', () => {
  it('creates a shadow-DOM overlay host with a crosshair surface', () => {
    armSelectionMode(1);

    const host = document.getElementById('fontcia-overlay-host');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();

    const surface = host?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.style.cursor).toBe('crosshair');
  });

  it('tears down the overlay on dismiss', () => {
    armSelectionMode(1);
    dismissSelection();

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('clears the selection-active flag for the current tab on dismiss', async () => {
    await markSelectionActive(1);

    armSelectionMode(1);
    dismissSelection();

    await expect(isSelectionActive(1)).resolves.toBe(false);
  });

  it('does not leak the previous overlay host when armed twice without a dismiss', () => {
    armSelectionMode(1);
    armSelectionMode(1);

    expect(document.querySelectorAll('#fontcia-overlay-host').length).toBe(1);
  });

  it('tears down the overlay on Escape', () => {
    armSelectionMode(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('is safe to call dismissSelection when nothing is armed', () => {
    expect(() => dismissSelection()).not.toThrow();
  });

  it('marks the tab as selection-active when armed', async () => {
    armSelectionMode(1);

    await expect(isSelectionActive(1)).resolves.toBe(true);
  });
});

function dispatchMouse(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

describe('drag lifecycle', () => {
  it('draws a live draft box while dragging', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mousemove', 60, 40);

    const draft = surface.querySelector('.fontcia-draft-box') as HTMLElement;
    expect(draft).not.toBeNull();
    expect(draft.style.width).toBe('50px');
    expect(draft.style.height).toBe('30px');
  });

  it('locks a real drag into a box + panel and removes the draft box', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mousemove', 60, 40);
    dispatchMouse(surface, 'mouseup', 60, 40);

    expect(surface.querySelector('.fontcia-draft-box')).toBeNull();
    expect(surface.querySelector('.fontcia-box')).not.toBeNull();
    expect(surface.querySelector('.fontcia-panel')).not.toBeNull();
  });

  it('resets the cursor to default once a selection locks', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;

    expect(surface.style.cursor).toBe('crosshair');

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 60, 40);

    expect(surface.style.cursor).toBe('default');
  });

  it('stops the host from capturing clicks once a selection locks, so the panel stays interactive', () => {
    armSelectionMode(1);
    const host = document.getElementById('fontcia-overlay-host') as HTMLElement;
    const surface = host.shadowRoot?.querySelector('.fontcia-surface') as HTMLElement;

    expect(host.style.pointerEvents).toBe('');

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 60, 40);

    expect(host.style.pointerEvents).toBe('none');
  });

  it('treats a sub-threshold drag as a no-op and stays armed', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 12, 10);

    expect(surface.querySelector('.fontcia-box')).toBeNull();
    expect(surface.querySelector('.fontcia-panel')).toBeNull();
    expect(document.getElementById('fontcia-overlay-host')).not.toBeNull();
  });

  it('dismisses the locked panel via its close button', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 60, 40);

    const closeBtn = surface.querySelector('.fontcia-panel-close') as HTMLElement;
    closeBtn.click();

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('ignores a second drag once a selection is already locked', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 60, 40);

    dispatchMouse(surface, 'mousedown', 100, 100);
    dispatchMouse(surface, 'mousemove', 160, 140);
    dispatchMouse(surface, 'mouseup', 160, 140);

    expect(surface.querySelectorAll('.fontcia-box').length).toBe(1);
    expect(surface.querySelectorAll('.fontcia-panel').length).toBe(1);
  });

  it('does not start a new drag when mousedown originates on the locked panel', () => {
    armSelectionMode(1);
    const surface = document.querySelector('#fontcia-overlay-host')?.shadowRoot?.querySelector('.fontcia-surface') as Element;

    dispatchMouse(surface, 'mousedown', 10, 10);
    dispatchMouse(surface, 'mouseup', 60, 40);

    const panel = surface.querySelector('.fontcia-panel') as Element;
    dispatchMouse(panel, 'mousedown', 15, 65);
    dispatchMouse(panel, 'mousemove', 90, 120);
    dispatchMouse(panel, 'mouseup', 90, 120);

    expect(surface.querySelectorAll('.fontcia-box').length).toBe(1);
    expect(surface.querySelectorAll('.fontcia-panel').length).toBe(1);
  });
});
