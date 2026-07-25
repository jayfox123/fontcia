import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import { resolveFontFromSelection } from './font-resolver';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
} from './scan-dialogue';

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
  // Held for a future sub-project's image-matching call — not read anywhere
  // in this sub-project, which is capture-and-crop plumbing only. Deliberately
  // still assigned (not just logged) so it survives past this closure's
  // console.log call, ready for that later consumer.
  let capturedImageBlob: Blob | null = null;

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
          capturedImageBlob = response.blob;
          console.log('fontCIA: captured image for analysis', capturedImageBlob);
          // Stays on "Analyzing image…" — no matcher exists yet; a future
          // sub-project replaces this branch with a real result render.
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

  renderReadyState(body, handleScan);

  function handleAuthChange(changes: Record<string, unknown>, areaName: string): void {
    if (areaName !== 'local' || !('fontcia-auth' in changes)) return;
    void renderResult();
  }

  chrome.storage.onChanged.addListener(handleAuthChange);

  function dispose(): void {
    disposed = true;
    chrome.storage.onChanged.removeListener(handleAuthChange);
  }

  return { box, panel, dispose };
}
