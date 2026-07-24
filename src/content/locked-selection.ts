import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import { resolveFontFromSelection } from './font-resolver';
import { renderReadyState, renderLoadingState, renderResultState, renderNoMatchState } from './scan-dialogue';

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

  function handleLoginPrompt(): void {
    window.open(chrome.runtime.getURL('login/login.html'), '_blank');
  }

  async function renderResult(): Promise<void> {
    if (!currentResult) return;
    const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
    if (disposed || !currentResult) return;
    const isLoggedIn = authRes.ok && authRes.data.loggedIn;
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
    if (!currentResult) return;
    const wasSaved = savedFontId !== null;
    const saveBtn = body.querySelector('.fontcia-btn-primary') as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;

    if (wasSaved) {
      const idToDelete = savedFontId as string;
      sendApiMessage<null>({ type: 'DELETE_SAVED_FONT', id: idToDelete })
        .then((res) => {
          if (disposed) return;
          if (res.ok) {
            savedFontId = null;
          } else {
            console.error('fontCIA: unsave failed', res.error);
          }
          void renderResult();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.error('fontCIA: unsave failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    } else {
      const { fontName, confidence, sources } = currentResult;
      sendApiMessage<{ id: string }>({ type: 'SAVE_FONT', fontName, confidence, sources })
        .then((res) => {
          if (disposed) return;
          if (res.ok) {
            savedFontId = res.data.id;
          } else {
            console.error('fontCIA: save failed', res.error);
          }
          void renderResult();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.error('fontCIA: save failed', error);
          if (saveBtn) saveBtn.disabled = false;
        });
    }
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
