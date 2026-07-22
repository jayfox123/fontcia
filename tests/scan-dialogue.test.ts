import { describe, it, expect, vi } from 'vitest';
import { renderReadyState, renderLoadingState } from '../src/content/scan-dialogue';

describe('renderReadyState', () => {
  it('renders a Scan button that calls onScan when clicked', () => {
    const body = document.createElement('div');
    const onScan = vi.fn();

    renderReadyState(body, onScan);

    const btn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Scan');

    btn.click();
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('clears any previous content before rendering', () => {
    const body = document.createElement('div');
    body.textContent = 'stale content';

    renderReadyState(body, vi.fn());

    expect(body.textContent).not.toContain('stale content');
  });
});

describe('renderLoadingState', () => {
  it('renders a spinner with no interactive elements', () => {
    const body = document.createElement('div');

    renderLoadingState(body);

    expect(body.querySelector('.fontcia-spinner')).not.toBeNull();
    expect(body.querySelector('button')).toBeNull();
  });
});
