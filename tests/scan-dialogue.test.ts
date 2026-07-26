import { describe, it, expect, vi } from 'vitest';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
} from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';
import type { RankedMatch } from '../src/shared/match-messages';

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

describe('renderAnalyzingImageState', () => {
  it('renders a spinner and an analyzing message with no interactive elements', () => {
    const body = document.createElement('div');

    renderAnalyzingImageState(body);

    expect(body.querySelector('.fontcia-spinner')).not.toBeNull();
    expect(body.querySelector('.fontcia-analyzing-message')?.textContent).toBe('Analyzing image…');
    expect(body.querySelector('button')).toBeNull();
  });

  it('clears any previous content before rendering', () => {
    const body = document.createElement('div');
    body.textContent = 'stale content';

    renderAnalyzingImageState(body);

    expect(body.textContent).not.toContain('stale content');
  });
});

describe('renderCaptureBlockedState', () => {
  it('renders a message and a New scan button, with no Name-it button', () => {
    const body = document.createElement('div');

    renderCaptureBlockedState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'Name it')).toBe(false);
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderCaptureBlockedState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderRankedMatchesState', () => {
  const candidates: RankedMatch[] = [
    {
      fontName: 'Inter',
      confidence: 82,
      sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
    },
    {
      fontName: 'Roboto',
      confidence: 61,
      sources: [{ url: 'https://fonts.google.com/specimen/Roboto', label: 'Google Fonts', votes: 1 }],
    },
  ];

  it('renders one item per candidate with its name, confidence, and sources', () => {
    const body = document.createElement('div');

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), true, vi.fn());

    const items = body.querySelectorAll('.fontcia-match-item');
    expect(items).toHaveLength(2);

    const names = Array.from(body.querySelectorAll('.fontcia-match-name')).map((el) => el.textContent);
    expect(names).toEqual(['Inter', 'Roboto']);

    const confidences = Array.from(body.querySelectorAll('.fontcia-match-confidence')).map((el) => el.textContent);
    expect(confidences).toEqual(['82% confidence', '61% confidence']);

    const links = body.querySelectorAll('.fontcia-source-link');
    expect(links).toHaveLength(2);
  });

  it('shows independent saved state per candidate when logged in', () => {
    const body = document.createElement('div');

    renderRankedMatchesState(body, candidates, [false, true], vi.fn(), vi.fn(), true, vi.fn());

    const saveButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(saveButtons).toHaveLength(2);
    expect(saveButtons[0].textContent).toBe('☆ Save');
    expect(saveButtons[1].textContent).toBe('★ Saved');
  });

  it("calls onToggleSave with the clicked candidate's own index", () => {
    const body = document.createElement('div');
    const onToggleSave = vi.fn();

    renderRankedMatchesState(body, candidates, [false, false], onToggleSave, vi.fn(), true, vi.fn());

    const saveButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    saveButtons[1].click();

    expect(onToggleSave).toHaveBeenCalledWith(1);
    expect(onToggleSave).toHaveBeenCalledOnce();
  });

  it('shows "Log in to save" for every candidate instead of Save/Saved when not logged in', () => {
    const body = document.createElement('div');

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), false, vi.fn());

    const loginButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    expect(loginButtons).toHaveLength(2);
    expect(loginButtons.every((btn) => btn.textContent === 'Log in to save')).toBe(true);
  });

  it('calls onLoginPrompt when a "Log in to save" button is clicked', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), false, onLoginPrompt);

    const loginButtons = Array.from(body.querySelectorAll('.fontcia-btn-primary')) as HTMLButtonElement[];
    loginButtons[0].click();

    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });

  it('renders exactly one shared New scan button, not one per candidate', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), onNewScan, true, vi.fn());

    const newScanButtons = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).filter(
      (btn) => btn.textContent === 'New scan',
    );
    expect(newScanButtons).toHaveLength(1);

    (newScanButtons[0] as HTMLButtonElement).click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });

  it('clears any previous content before rendering', () => {
    const body = document.createElement('div');
    body.textContent = 'stale content';

    renderRankedMatchesState(body, candidates, [false, false], vi.fn(), vi.fn(), true, vi.fn());

    expect(body.textContent).not.toContain('stale content');
  });
});

describe('renderNoConfidentMatchState', () => {
  it('renders distinct copy from renderNoMatchState, with a New scan button', () => {
    const body = document.createElement('div');

    renderNoConfidentMatchState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoConfidentMatchState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderMatchErrorState', () => {
  it('renders distinct copy from the other message states, with a New scan button', () => {
    const body = document.createElement('div');

    renderMatchErrorState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong analyzing this image.',
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderMatchErrorState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
