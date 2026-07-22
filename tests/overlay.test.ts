import { describe, it, expect, afterEach } from 'vitest';
import { armSelectionMode, dismissSelection } from '../src/content/overlay';

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

  it('tears down the overlay on Escape', () => {
    armSelectionMode(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('fontcia-overlay-host')).toBeNull();
  });

  it('is safe to call dismissSelection when nothing is armed', () => {
    expect(() => dismissSelection()).not.toThrow();
  });
});
