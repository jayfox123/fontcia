import { describe, it, expect, vi } from 'vitest';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';

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

describe('renderResultState', () => {
  const result: MatchResult = {
    status: 'match',
    fontName: 'Inter',
    confidence: 92,
    sources: [
      { url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 14 },
      { url: 'https://rsms.me/inter/', label: 'Official site', votes: 6 },
    ],
  };

  it('renders the font name, confidence, and all sources', () => {
    const body = document.createElement('div');

    renderResultState(body, result, false, vi.fn(), vi.fn(), true, vi.fn());

    expect(body.querySelector('.fontcia-result-font')?.textContent).toBe('Inter');
    expect(body.querySelector('.fontcia-confidence')?.textContent).toBe('92% confidence');

    const links = body.querySelectorAll('.fontcia-source-link');
    expect(links.length).toBe(2);
    expect((links[0] as HTMLAnchorElement).href).toBe('https://fonts.google.com/specimen/Inter');
  });

  it('shows unsaved state and calls onToggleSave on click when logged in', () => {
    const body = document.createElement('div');
    const onToggleSave = vi.fn();

    renderResultState(body, result, false, onToggleSave, vi.fn(), true, vi.fn());

    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('☆ Save');

    saveBtn.click();
    expect(onToggleSave).toHaveBeenCalledOnce();
  });

  it('shows saved state when saved is true and logged in', () => {
    const body = document.createElement('div');

    renderResultState(body, result, true, vi.fn(), vi.fn(), true, vi.fn());

    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(saveBtn.textContent).toBe('★ Saved');
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderResultState(body, result, false, vi.fn(), onNewScan, true, vi.fn());

    const newScanBtn = body.querySelector('.fontcia-btn-secondary') as HTMLButtonElement;
    expect(newScanBtn.textContent).toBe('New scan');

    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });

  it('shows a "Log in to save" button instead of Save/Saved when not logged in', () => {
    const body = document.createElement('div');

    renderResultState(body, result, false, vi.fn(), vi.fn(), false, vi.fn());

    const loginBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    expect(loginBtn.textContent).toBe('Log in to save');
  });

  it('calls onLoginPrompt when "Log in to save" is clicked', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderResultState(body, result, false, vi.fn(), vi.fn(), false, onLoginPrompt);

    const loginBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement;
    loginBtn.click();

    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });
});

describe('renderNoMatchState', () => {
  it('renders a message and a disabled Name-it button', () => {
    const body = document.createElement('div');

    renderNoMatchState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')).not.toBeNull();

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoMatchState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;

    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
