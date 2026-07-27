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
  renderUnrecognizedFontState,
  renderEnrollmentFormState,
  renderEnrollmentSubmittedState,
  renderEnrollmentErrorState,
} from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';
import type { RankedMatch } from '../src/shared/match-messages';
import type { PendingSuggestion } from '../src/content/scan-dialogue';

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

    renderNoConfidentMatchState(body, true, vi.fn(), vi.fn(), vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoConfidentMatchState(body, true, vi.fn(), vi.fn(), onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });

  it('shows an enabled Name it button and calls onNameIt when logged in', () => {
    const body = document.createElement('div');
    const onNameIt = vi.fn();

    renderNoConfidentMatchState(body, true, onNameIt, vi.fn(), vi.fn());

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);

    nameItBtn.click();
    expect(onNameIt).toHaveBeenCalledOnce();
  });

  it('shows a "Log in to name it" button instead when not logged in', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderNoConfidentMatchState(body, false, vi.fn(), onLoginPrompt, vi.fn());

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const loginBtn = buttons.find((b) => b.textContent === 'Log in to name it') as HTMLButtonElement;
    expect(buttons.some((b) => b.textContent === 'Name it')).toBe(false);

    loginBtn.click();
    expect(onLoginPrompt).toHaveBeenCalledOnce();
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

describe('renderUnrecognizedFontState', () => {
  it('renders the same message copy as renderNoMatchState, with an enabled Name it button when logged in', () => {
    const body = document.createElement('div');
    const onNameIt = vi.fn();

    renderUnrecognizedFontState(body, true, onNameIt, vi.fn(), vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);

    nameItBtn.click();
    expect(onNameIt).toHaveBeenCalledOnce();
  });

  it('shows a "Log in to name it" button instead when not logged in', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderUnrecognizedFontState(body, false, vi.fn(), onLoginPrompt, vi.fn());

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'Name it')).toBe(false);
    const loginBtn = buttons.find((b) => b.textContent === 'Log in to name it') as HTMLButtonElement;

    loginBtn.click();
    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderUnrecognizedFontState(body, true, vi.fn(), vi.fn(), onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderEnrollmentFormState', () => {
  const suggestions: PendingSuggestion[] = [
    { id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 },
    { id: 'sub-2', fontName: 'Brandon Text', confirmationCount: 2 },
  ];

  it('renders a font-name input, a source-URL input, a Submit button, and a Cancel button', () => {
    const body = document.createElement('div');

    renderEnrollmentFormState(body, [], vi.fn(), vi.fn(), vi.fn());

    const inputs = body.querySelectorAll('.fontcia-input');
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).placeholder).toBe('Font name');
    expect((inputs[1] as HTMLInputElement).placeholder).toBe('Source URL (optional)');

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn'));
    expect(buttons.some((b) => b.textContent === 'Submit')).toBe(true);
    expect(buttons.some((b) => b.textContent === 'Cancel')).toBe(true);
  });

  it('shows no suggestions until the font-name input has text', () => {
    const body = document.createElement('div');

    renderEnrollmentFormState(body, suggestions, vi.fn(), vi.fn(), vi.fn());

    expect(body.querySelectorAll('.fontcia-suggestion-item')).toHaveLength(0);
  });

  it('live-filters suggestions as the user types, case-insensitively', () => {
    const body = document.createElement('div');

    renderEnrollmentFormState(body, suggestions, vi.fn(), vi.fn(), vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'GROTESQUE';
    nameInput.dispatchEvent(new Event('input'));

    const items = body.querySelectorAll('.fontcia-suggestion-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Brandon Grotesque');
    expect(items[0].textContent).toContain('1 confirmation so far');
  });

  it("calls onConfirmExisting with the picked suggestion's id and null when no source URL was typed", () => {
    const body = document.createElement('div');
    const onConfirmExisting = vi.fn();

    renderEnrollmentFormState(body, suggestions, onConfirmExisting, vi.fn(), vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const items = Array.from(body.querySelectorAll('.fontcia-suggestion-item')) as HTMLButtonElement[];
    expect(items).toHaveLength(2);
    items[1].click();

    expect(onConfirmExisting).toHaveBeenCalledWith('sub-2', null);
  });

  it('calls onConfirmExisting with whatever source URL was typed into the source-URL field', () => {
    const body = document.createElement('div');
    const onConfirmExisting = vi.fn();

    renderEnrollmentFormState(body, suggestions, onConfirmExisting, vi.fn(), vi.fn());

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'brandon';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'https://fonts.adobe.com/fonts/brandon-grotesque';

    const items = Array.from(body.querySelectorAll('.fontcia-suggestion-item')) as HTMLButtonElement[];
    items[0].click();

    expect(onConfirmExisting).toHaveBeenCalledWith('sub-1', 'https://fonts.adobe.com/fonts/brandon-grotesque');
  });

  it('calls onSubmitNew with the typed name and source URL when Submit is clicked', () => {
    const body = document.createElement('div');
    const onSubmitNew = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), onSubmitNew, vi.fn());

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';
    inputs[1].value = 'https://example.com';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmitNew).toHaveBeenCalledWith('New Font Name', 'https://example.com');
  });

  it('passes null for sourceUrl when it was left blank', () => {
    const body = document.createElement('div');
    const onSubmitNew = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), onSubmitNew, vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'New Font Name';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmitNew).toHaveBeenCalledWith('New Font Name', null);
  });

  it('does not call onSubmitNew when the font name is blank', () => {
    const body = document.createElement('div');
    const onSubmitNew = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), onSubmitNew, vi.fn());

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmitNew).not.toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const body = document.createElement('div');
    const onCancel = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), vi.fn(), onCancel);

    const cancelBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('renderEnrollmentSubmittedState', () => {
  it('renders a thank-you message and a New scan button', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderEnrollmentSubmittedState(body, onNewScan);

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Thanks! Pending community confirmation.',
    );
    const newScanBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;
    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderEnrollmentErrorState', () => {
  it('renders distinct copy from the other message states, with a New scan button', () => {
    const body = document.createElement('div');

    renderEnrollmentErrorState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong submitting this.',
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderEnrollmentErrorState(body, onNewScan);

    const newScanBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
