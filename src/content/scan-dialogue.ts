import type { MatchResult } from './scan-types';
import type { RankedMatch } from '../shared/match-messages';

export function renderReadyState(body: HTMLElement, onScan: () => void): void {
  body.replaceChildren();

  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'fontcia-btn fontcia-btn-primary';
  scanBtn.textContent = 'Scan';
  scanBtn.addEventListener('click', onScan);

  body.appendChild(scanBtn);
}

export function renderLoadingState(body: HTMLElement): void {
  body.replaceChildren();

  const spinner = document.createElement('div');
  spinner.className = 'fontcia-spinner';

  body.appendChild(spinner);
}

export function renderResultState(
  body: HTMLElement,
  result: MatchResult,
  saved: boolean,
  onToggleSave: () => void,
  onNewScan: () => void,
  isLoggedIn: boolean,
  onLoginPrompt: () => void,
): void {
  body.replaceChildren();

  const fontName = document.createElement('div');
  fontName.className = 'fontcia-result-font';
  fontName.textContent = result.fontName;
  body.appendChild(fontName);

  const confidence = document.createElement('div');
  confidence.className = 'fontcia-confidence';
  confidence.textContent = `${result.confidence}% confidence`;
  body.appendChild(confidence);

  const sourcesList = document.createElement('ul');
  sourcesList.className = 'fontcia-sources';
  for (const source of result.sources) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'fontcia-source-link';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.label;
    item.appendChild(link);
    sourcesList.appendChild(item);
  }
  body.appendChild(sourcesList);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  if (isLoggedIn) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'fontcia-btn fontcia-btn-primary';
    saveBtn.textContent = saved ? '★ Saved' : '☆ Save';
    saveBtn.addEventListener('click', onToggleSave);
    actions.appendChild(saveBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-primary';
    loginBtn.textContent = 'Log in to save';
    loginBtn.addEventListener('click', onLoginPrompt);
    actions.appendChild(loginBtn);
  }

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderNoMatchState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "We don't recognize this one.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const nameItBtn = document.createElement('button');
  nameItBtn.type = 'button';
  nameItBtn.className = 'fontcia-btn fontcia-btn-secondary';
  nameItBtn.textContent = 'Name it';
  nameItBtn.disabled = true;
  actions.appendChild(nameItBtn);

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderAnalyzingImageState(body: HTMLElement): void {
  body.replaceChildren();

  const spinner = document.createElement('div');
  spinner.className = 'fontcia-spinner';
  body.appendChild(spinner);

  const message = document.createElement('div');
  message.className = 'fontcia-analyzing-message';
  message.textContent = 'Analyzing image…';
  body.appendChild(message);
}

export function renderCaptureBlockedState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "Can't capture this content.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderRankedMatchesState(
  body: HTMLElement,
  candidates: RankedMatch[],
  savedFlags: boolean[],
  onToggleSave: (index: number) => void,
  onNewScan: () => void,
  isLoggedIn: boolean,
  onLoginPrompt: () => void,
): void {
  body.replaceChildren();

  const list = document.createElement('div');
  list.className = 'fontcia-match-list';

  candidates.forEach((candidate, index) => {
    const item = document.createElement('div');
    item.className = 'fontcia-match-item';

    const name = document.createElement('div');
    name.className = 'fontcia-match-name';
    name.textContent = candidate.fontName;
    item.appendChild(name);

    const confidence = document.createElement('div');
    confidence.className = 'fontcia-match-confidence';
    confidence.textContent = `${candidate.confidence}% confidence`;
    item.appendChild(confidence);

    const sourcesList = document.createElement('ul');
    sourcesList.className = 'fontcia-sources';
    for (const source of candidate.sources) {
      const sourceItem = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'fontcia-source-link';
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.label;
      sourceItem.appendChild(link);
      sourcesList.appendChild(sourceItem);
    }
    item.appendChild(sourcesList);

    const actions = document.createElement('div');
    actions.className = 'fontcia-result-actions';

    if (isLoggedIn) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'fontcia-btn fontcia-btn-primary';
      saveBtn.dataset.candidateIndex = String(index);
      saveBtn.textContent = savedFlags[index] ? '★ Saved' : '☆ Save';
      saveBtn.addEventListener('click', () => onToggleSave(index));
      actions.appendChild(saveBtn);
    } else {
      const loginBtn = document.createElement('button');
      loginBtn.type = 'button';
      loginBtn.className = 'fontcia-btn fontcia-btn-primary';
      loginBtn.textContent = 'Log in to save';
      loginBtn.addEventListener('click', onLoginPrompt);
      actions.appendChild(loginBtn);
    }

    item.appendChild(actions);
    list.appendChild(item);
  });

  body.appendChild(list);

  const sharedActions = document.createElement('div');
  sharedActions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  sharedActions.appendChild(newScanBtn);

  body.appendChild(sharedActions);
}

export function renderNoConfidentMatchState(
  body: HTMLElement,
  isLoggedIn: boolean,
  onNameIt: () => void,
  onLoginPrompt: () => void,
  onNewScan: () => void,
): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "Couldn't find a confident match for this font.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  if (isLoggedIn) {
    const nameItBtn = document.createElement('button');
    nameItBtn.type = 'button';
    nameItBtn.className = 'fontcia-btn fontcia-btn-secondary';
    nameItBtn.textContent = 'Name it';
    nameItBtn.addEventListener('click', onNameIt);
    actions.appendChild(nameItBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-secondary';
    loginBtn.textContent = 'Log in to name it';
    loginBtn.addEventListener('click', onLoginPrompt);
    actions.appendChild(loginBtn);
  }

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderMatchErrorState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = 'Something went wrong analyzing this image.';
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderUnrecognizedFontState(
  body: HTMLElement,
  isLoggedIn: boolean,
  onNameIt: () => void,
  onLoginPrompt: () => void,
  onNewScan: () => void,
): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "We don't recognize this one.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  if (isLoggedIn) {
    const nameItBtn = document.createElement('button');
    nameItBtn.type = 'button';
    nameItBtn.className = 'fontcia-btn fontcia-btn-secondary';
    nameItBtn.textContent = 'Name it';
    nameItBtn.addEventListener('click', onNameIt);
    actions.appendChild(nameItBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-secondary';
    loginBtn.textContent = 'Log in to name it';
    loginBtn.addEventListener('click', onLoginPrompt);
    actions.appendChild(loginBtn);
  }

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export interface PendingSuggestion {
  id: string;
  fontName: string;
  confirmationCount: number;
}

export function renderEnrollmentFormState(
  body: HTMLElement,
  pendingSuggestions: PendingSuggestion[],
  onConfirmExisting: (id: string) => void,
  onSubmitNew: (fontName: string, sourceUrl: string | null) => void,
  onCancel: () => void,
): void {
  body.replaceChildren();

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'fontcia-input';
  nameInput.placeholder = 'Font name';
  body.appendChild(nameInput);

  const suggestionsList = document.createElement('div');
  suggestionsList.className = 'fontcia-suggestions';
  body.appendChild(suggestionsList);

  function renderSuggestions(): void {
    suggestionsList.replaceChildren();
    const query = nameInput.value.trim().toLowerCase();
    if (query.length === 0) return;
    const matches = pendingSuggestions.filter((s) => s.fontName.toLowerCase().includes(query));
    for (const match of matches) {
      const suggestionBtn = document.createElement('button');
      suggestionBtn.type = 'button';
      suggestionBtn.className = 'fontcia-suggestion-item';
      const confirmationWord = match.confirmationCount === 1 ? 'confirmation' : 'confirmations';
      suggestionBtn.textContent = `Confirm as: ${match.fontName} (${match.confirmationCount} ${confirmationWord} so far)`;
      suggestionBtn.addEventListener('click', () => onConfirmExisting(match.id));
      suggestionsList.appendChild(suggestionBtn);
    }
  }

  nameInput.addEventListener('input', renderSuggestions);

  const sourceUrlInput = document.createElement('input');
  sourceUrlInput.type = 'text';
  sourceUrlInput.className = 'fontcia-input';
  sourceUrlInput.placeholder = 'Source URL (optional)';
  body.appendChild(sourceUrlInput);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'fontcia-btn fontcia-btn-primary';
  submitBtn.textContent = 'Submit';
  submitBtn.addEventListener('click', () => {
    const fontName = nameInput.value.trim();
    if (fontName.length === 0) return;
    const sourceUrl = sourceUrlInput.value.trim();
    onSubmitNew(fontName, sourceUrl.length > 0 ? sourceUrl : null);
  });
  actions.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'fontcia-btn fontcia-btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);
  actions.appendChild(cancelBtn);

  body.appendChild(actions);
}

export function renderEnrollmentSubmittedState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = 'Thanks! Pending community confirmation.';
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderEnrollmentErrorState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = 'Something went wrong submitting this.';
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
