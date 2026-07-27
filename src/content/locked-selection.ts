import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult, ImageMatchResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse, RankedMatch } from '../shared/match-messages';
import { resolveFontFromSelection } from './font-resolver';
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
} from './scan-dialogue';
import { startEnrollment, captureSampleBlob } from './enrollment';

export interface LockedSelectionElements {
  box: HTMLDivElement;
  panel: HTMLDivElement;
  dispose: () => void;
}

function applyRect(el: HTMLDivElement, rect: Rect): void {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

// Deliberately not an `async function`: wrapping this in `async` would add an
// extra microtask tick (the async-function-returns-a-promise adoption step)
// on top of the tick already spent resolving the underlying
// chrome.runtime.sendMessage() call. Returning the promise directly keeps the
// call chain (scan -> GET_AUTH_STATE -> render) to the minimum number of
// microtask hops.
function sendApiMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export function renderLockedSelection(
  container: ParentNode,
  rect: Rect,
  onDismiss: () => void,
  onRestart: () => void,
  scanFn: (rect: Rect) => Promise<ScanResult> = resolveFontFromSelection,
): LockedSelectionElements {
  const box = document.createElement('div');
  box.className = 'fontcia-box';
  applyRect(box, rect);
  container.appendChild(box);

  const panel = document.createElement('div');
  panel.className = 'fontcia-panel';
  panel.style.left = `${rect.x}px`;
  panel.style.top = `${rect.y + rect.height + 8}px`;
  // Stop mouse events on the panel from bubbling to the drag surface underneath
  // it, so interacting with panel content (e.g. a future scrollable area) can't
  // be mistaken for a new drag gesture.
  panel.addEventListener('mousedown', (event) => event.stopPropagation());

  const notch = document.createElement('div');
  notch.className = 'fontcia-notch';
  panel.appendChild(notch);

  const header = document.createElement('div');
  header.className = 'fontcia-panel-header';

  const title = document.createElement('strong');
  title.textContent = 'Scan dialogue';
  header.appendChild(title);

  const closeBtn = document.createElement('span');
  closeBtn.className = 'fontcia-panel-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', onDismiss);
  header.appendChild(closeBtn);

  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'fontcia-panel-body';
  panel.appendChild(body);

  container.appendChild(panel);

  // State is scoped to this one closure — a fresh instance every time a
  // selection locks, never module-level, so there's no cross-instance leakage.
  let disposed = false;
  let savedFontId: string | null = null;
  let currentResult: MatchResult | null = null;
  // Guards the SAVE_FONT/DELETE_SAVED_FONT round trip against two distinct
  // hazards: (1) a chrome.storage.onChanged fire — routinely triggered by the
  // very request in flight, since a 401-refresh-and-retry inside api-client.ts
  // writes to the same 'fontcia-auth' key this file listens on — re-rendering
  // a fresh, non-disabled button mid-request; and (2) a second click landing
  // while the first request is still outstanding. Both are closed by the same
  // flag: renderResult() no-ops while it's set, and handleToggleSave() itself
  // refuses to start a second round trip while one is pending.
  let togglePending = false;
  // Same shape as currentResult/savedFontId/togglePending above, but the
  // image-match path can show several independently-saveable candidates at
  // once, so each piece of per-candidate state is its own parallel array
  // instead of a single scalar.
  let currentCandidates: RankedMatch[] | null = null;
  let candidateSavedIds: (string | null)[] = [];
  let candidateTogglePending: boolean[] = [];

  function handleLoginPrompt(): void {
    window.open(chrome.runtime.getURL('login/login.html'), '_blank');
  }

  async function renderResult(): Promise<void> {
    if (!currentResult || togglePending) return;
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      // GET_AUTH_STATE is a pure local read per Task 3 and shouldn't normally
      // reject, but if the service worker is asleep or the extension context
      // was invalidated, degrade to the logged-out UI rather than leaving
      // whatever was on screen (e.g. a disabled Save button) stuck forever.
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed || !currentResult) return;
    renderResultState(
      body,
      currentResult,
      savedFontId !== null,
      handleToggleSave,
      onRestart,
      isLoggedIn,
      handleLoginPrompt,
    );
  }

  function showResult(result: MatchResult): void {
    currentResult = result;
    savedFontId = null;
    void renderResult();
  }

  function handleToggleSave(): void {
    if (!currentResult || togglePending) return;
    togglePending = true;
    const wasSaved = savedFontId !== null;
    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;

    if (wasSaved) {
      const idToDelete = savedFontId as string;
      sendApiMessage<null>({ type: 'DELETE_SAVED_FONT', id: idToDelete })
        .then((res) => {
          togglePending = false;
          if (disposed) return;
          if (res.ok) {
            savedFontId = null;
          } else {
            console.error('fontCIA: unsave failed', res.error);
          }
          void renderResult();
        })
        .catch((error: unknown) => {
          togglePending = false;
          if (disposed) return;
          console.error('fontCIA: unsave failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    } else {
      const { fontName, confidence, sources } = currentResult;
      sendApiMessage<{ id: string }>({ type: 'SAVE_FONT', fontName, confidence, sources })
        .then((res) => {
          togglePending = false;
          if (disposed) return;
          if (res.ok) {
            savedFontId = res.data.id;
          } else {
            console.error('fontCIA: save failed', res.error);
          }
          void renderResult();
        })
        .catch((error: unknown) => {
          togglePending = false;
          if (disposed) return;
          console.error('fontCIA: save failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    }
  }

  async function renderCandidates(): Promise<void> {
    if (!currentCandidates) return;
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed || !currentCandidates) return;
    renderRankedMatchesState(
      body,
      currentCandidates,
      candidateSavedIds.map((id) => id !== null),
      handleToggleCandidateSave,
      onRestart,
      isLoggedIn,
      handleLoginPrompt,
    );
  }

  function showCandidates(candidates: RankedMatch[]): void {
    currentCandidates = candidates;
    candidateSavedIds = candidates.map(() => null);
    candidateTogglePending = candidates.map(() => false);
    void renderCandidates();
  }

  function handleToggleCandidateSave(index: number): void {
    if (!currentCandidates || candidateTogglePending[index]) return;
    const candidate = currentCandidates[index];
    candidateTogglePending[index] = true;
    const wasSaved = candidateSavedIds[index] !== null;
    const saveBtn = body.querySelector(`[data-candidate-index="${index}"]`) as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;

    if (wasSaved) {
      const idToDelete = candidateSavedIds[index] as string;
      sendApiMessage<null>({ type: 'DELETE_SAVED_FONT', id: idToDelete })
        .then((res) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          if (res.ok) {
            candidateSavedIds[index] = null;
          } else {
            console.error('fontCIA: unsave failed', res.error);
          }
          void renderCandidates();
        })
        .catch((error: unknown) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          console.error('fontCIA: unsave failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    } else {
      const { fontName, confidence, sources } = candidate;
      sendApiMessage<{ id: string }>({ type: 'SAVE_FONT', fontName, confidence, sources })
        .then((res) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          if (res.ok) {
            candidateSavedIds[index] = res.data.id;
          } else {
            console.error('fontCIA: save failed', res.error);
          }
          void renderCandidates();
        })
        .catch((error: unknown) => {
          candidateTogglePending[index] = false;
          if (disposed) return;
          console.error('fontCIA: save failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    }
  }

  function handleNoTextResult(): void {
    renderAnalyzingImageState(body);
    const message: CaptureSelectionMessage = {
      type: 'CAPTURE_SELECTION',
      rect,
      devicePixelRatio: window.devicePixelRatio,
    };
    chrome.runtime
      .sendMessage(message)
      .then((response: CaptureResponse) => {
        if (disposed) return;
        if (response.status === 'captured') {
          handleImageCapture(response.blob);
        } else if (response.status === 'blocked') {
          renderCaptureBlockedState(body, onRestart);
        } else {
          console.error('fontCIA: image capture failed', response.message);
          renderCaptureBlockedState(body, onRestart);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error('fontCIA: image capture message failed', error);
        renderCaptureBlockedState(body, onRestart);
      });
  }

  function logImageMatchResult(result: ImageMatchResult): void {
    const message: ApiMessage =
      result.status === 'matches'
        ? {
            type: 'LOG_SCAN',
            status: 'match',
            fontName: result.candidates[0].fontName,
            confidence: result.candidates[0].confidence,
          }
        : { type: 'LOG_SCAN', status: 'no-match' };
    sendApiMessage<null>(message).catch((error: unknown) => {
      console.error('fontCIA: scan logging failed', error);
    });
  }

  function renderImageMatchResult(result: ImageMatchResult, blob: Blob): void {
    if (result.status === 'matches') {
      showCandidates(result.candidates);
    } else if (result.status === 'no-confident-match') {
      void renderNoConfidentMatch(blob);
    } else {
      renderMatchErrorState(body, onRestart);
    }
  }

  async function renderNoConfidentMatch(blob: Blob): Promise<void> {
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed) return;
    renderNoConfidentMatchState(body, isLoggedIn, () => handleNameItFromBlob(blob), handleLoginPrompt, onRestart);
  }

  function handleNameItFromBlob(blob: Blob): void {
    void startEnrollment({
      body,
      isDisposed: () => disposed,
      onCancel: onRestart,
      getSampleBlob: async () => ({ status: 'ok', blob }),
    });
  }

  function handleImageCapture(blob: Blob): void {
    const message: MatchImageMessage = { type: 'MATCH_IMAGE', blob };
    chrome.runtime
      .sendMessage(message)
      .then((response: MatchImageResponse) => {
        if (disposed) return;
        const result: ImageMatchResult =
          response.status === 'ok'
            ? response.matches.length > 0
              ? { status: 'matches', candidates: response.matches }
              : { status: 'no-confident-match' }
            : { status: 'error' };
        logImageMatchResult(result);
        renderImageMatchResult(result, blob);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error('fontCIA: image match message failed', error);
        renderMatchErrorState(body, onRestart);
      });
  }

  function logScanResult(result: ScanResult): void {
    const message: ApiMessage =
      result.status === 'match'
        ? { type: 'LOG_SCAN', status: 'match', fontName: result.fontName, confidence: result.confidence }
        : { type: 'LOG_SCAN', status: 'no-match' };
    sendApiMessage<null>(message).catch((error: unknown) => {
      console.error('fontCIA: scan logging failed', error);
    });
  }

  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        // An in-flight scan must not touch the DOM after the panel is dismissed
        // (Esc, the close button, or an icon-click toggle-off) — all three
        // converge on overlay.ts's teardownOverlay(), which calls dispose()
        // before this promise can resolve into a stale render.
        if (disposed) return;
        if (result.status === 'match') {
          showResult(result);
        } else if (result.status === 'no-match' && result.reason === 'no-text') {
          handleNoTextResult();
        } else if (result.status === 'no-match' && result.reason === 'unrecognized') {
          void renderUnrecognizedFont();
        } else {
          renderNoMatchState(body, onRestart);
        }
      })
      .catch((error: unknown) => {
        logScanResult({ status: 'no-match', reason: 'error' });
        if (disposed) return;
        console.error('fontCIA: font resolution failed', error);
        renderNoMatchState(body, onRestart);
      });
  }

  async function renderUnrecognizedFont(): Promise<void> {
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed) return;
    renderUnrecognizedFontState(body, isLoggedIn, handleNameItFromDom, handleLoginPrompt, onRestart);
  }

  function handleNameItFromDom(): void {
    void startEnrollment({
      body,
      isDisposed: () => disposed,
      onCancel: onRestart,
      getSampleBlob: () => captureSampleBlob(rect, window.devicePixelRatio),
    });
  }

  renderReadyState(body, handleScan);

  function handleAuthChange(changes: Record<string, unknown>, areaName: string): void {
    if (areaName !== 'local' || !('fontcia-auth' in changes)) return;
    // Only one of currentResult/currentCandidates is ever active at a time —
    // each render function already no-ops when its own state is null, so
    // calling both unconditionally re-renders whichever view is actually on
    // screen without needing to track which flow is active separately.
    void renderResult();
    void renderCandidates();
  }

  chrome.storage.onChanged.addListener(handleAuthChange);

  function dispose(): void {
    disposed = true;
    chrome.storage.onChanged.removeListener(handleAuthChange);
  }

  return { box, panel, dispose };
}
