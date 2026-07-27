import { clearSelectionActive, markSelectionActive } from '../shared/session-state';
import { normalizeDragRect, isNoOpDrag, type Point } from '../shared/selection-box';
import { renderLockedSelection } from './locked-selection';
import { themeCss } from './theme';
import { getStoredTheme, THEME_STORAGE_KEY } from '../shared/theme-storage';

declare global {
  interface Window {
    __fontciaOverlayInjected?: boolean;
  }
}

let currentTabId: number | null = null;
let hostEl: HTMLDivElement | null = null;
let shadowSurface: HTMLDivElement | null = null;
let draftBox: HTMLDivElement | null = null;
let dragStart: Point | null = null;
let isDragging = false;
let isLocked = false;
let lockedDispose: (() => void) | null = null;

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    dismissSelection();
  }
}

function handleMouseDown(event: MouseEvent): void {
  // Only one locked selection per armed session — a second drag is ignored
  // until the first is dismissed, rather than stacking a duplicate box+panel.
  if (!shadowSurface || isLocked) return;
  draftBox?.remove();
  isDragging = true;
  dragStart = { x: event.clientX, y: event.clientY };
  draftBox = document.createElement('div');
  draftBox.className = 'fontcia-draft-box';
  shadowSurface.appendChild(draftBox);
}

function handleMouseMove(event: MouseEvent): void {
  if (!isDragging || !dragStart || !draftBox) return;
  const rect = normalizeDragRect(dragStart, { x: event.clientX, y: event.clientY });
  draftBox.style.left = `${rect.x}px`;
  draftBox.style.top = `${rect.y}px`;
  draftBox.style.width = `${rect.width}px`;
  draftBox.style.height = `${rect.height}px`;
}

function handleMouseUp(event: MouseEvent): void {
  if (!isDragging || !dragStart || !shadowSurface) return;
  const rect = normalizeDragRect(dragStart, { x: event.clientX, y: event.clientY });
  isDragging = false;
  draftBox?.remove();
  draftBox = null;
  dragStart = null;

  if (isNoOpDrag(rect)) return;

  const locked = renderLockedSelection(shadowSurface, rect, dismissSelection, restartSelection);
  lockedDispose = locked.dispose;
  isLocked = true;
  // The host stays in the DOM (it hosts the box/panel until dismiss), but
  // selection mode is otherwise fully off once locked — reset the cursor so
  // it doesn't keep showing crosshair over the rest of the page, and stop the
  // full-viewport host from capturing clicks outside the box/panel. Setting
  // this on the light-DOM host itself (not just the shadow-tree surface) is
  // what actually lets clicks fall through to the underlying page — the panel
  // opts back into pointer events via its own CSS rule (.fontcia-panel
  // { pointer-events: auto }), inherited by its close button, so both stay clickable.
  shadowSurface.style.cursor = 'default';
  if (hostEl) {
    hostEl.style.pointerEvents = 'none';
  }
}

// A separate, fire-and-forget async step rather than making createOverlay itself
// async: the crosshair cursor and drag handling must be available immediately with
// no user-visible delay, and neither depends on which theme is applied — only the
// colors do. This one extra chrome.storage.local round trip resolves well before a
// real user finishes their drag gesture.
async function applyStoredTheme(): Promise<void> {
  if (!shadowSurface) return;
  const theme = await getStoredTheme();
  if (!shadowSurface) return; // could have been torn down while this awaited
  shadowSurface.classList.toggle('theme-light', theme === 'light');
}

function createOverlay(): void {
  if (hostEl !== null) {
    teardownOverlay();
  }

  hostEl = document.createElement('div');
  hostEl.id = 'fontcia-overlay-host';
  Object.assign(hostEl.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
  document.body.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = themeCss;
  shadow.appendChild(style);

  shadowSurface = document.createElement('div');
  shadowSurface.className = 'fontcia-surface';
  // Set inline as well as via the .fontcia-surface CSS rule: jsdom's element.style
  // only reflects the inline style attribute, not applied stylesheet rules, and this
  // keeps the crosshair guaranteed even if the <style> tag were ever parsed late.
  shadowSurface.style.cursor = 'crosshair';
  shadow.appendChild(shadowSurface);
  void applyStoredTheme();

  shadowSurface.addEventListener('mousedown', handleMouseDown);
  shadowSurface.addEventListener('mousemove', handleMouseMove);
  shadowSurface.addEventListener('mouseup', handleMouseUp);

  document.addEventListener('keydown', handleKeydown);
}

function teardownOverlay(): void {
  // This is what makes dispose() actually fire for every real dismiss trigger
  // (Esc, panel close, and the DISMISS_SELECTION message all call
  // dismissSelection(), which calls this function), not just when dispose()
  // is called directly. Where within this function it's called doesn't matter
  // — the whole body runs synchronously with no await, so a pending
  // scanFn(...).then(...) callback can't interleave regardless — it just needs
  // to happen before this function returns.
  lockedDispose?.();
  lockedDispose = null;
  document.removeEventListener('keydown', handleKeydown);
  hostEl?.remove();
  hostEl = null;
  shadowSurface = null;
  draftBox = null;
  dragStart = null;
  isDragging = false;
  isLocked = false;
}

export function armSelectionMode(tabId: number): void {
  currentTabId = tabId;
  createOverlay();
  markSelectionActive(tabId).catch((error: unknown) =>
    console.error('fontCIA: failed to mark selection active', error),
  );
}

export function dismissSelection(): void {
  if (currentTabId !== null) {
    clearSelectionActive(currentTabId).catch((error: unknown) =>
      console.error('fontCIA: failed to clear selection-active flag', error),
    );
  }
  currentTabId = null;
  teardownOverlay();
}

function restartSelection(): void {
  // Deliberately does NOT go through dismissSelection(): the tab stays active
  // throughout a restart (the user is starting a fresh selection, not leaving),
  // so there's no need to clear the storage flag only to immediately re-mark it.
  // clearSelectionActive and markSelectionActive are both unawaited fire-and-forget
  // calls with no ordering guarantee between them — issuing both for the same tab
  // back-to-back would risk the mark losing a race against a slower clear against
  // real chrome.storage.session IPC, leaving the tab stuck "inactive" while the
  // overlay is genuinely re-armed. Tearing down the DOM directly and re-arming
  // (which re-marks active, an idempotent no-op if it was already true) avoids
  // that race entirely by never issuing the clear on this path.
  const tabId = currentTabId;
  currentTabId = null;
  teardownOverlay();
  if (tabId !== null) {
    armSelectionMode(tabId);
  }
}

// chrome.scripting.executeScript re-runs this entire script on every injection.
// A dismiss-then-rearm cycle on the same tab (no navigation) clears the
// selection-active flag, so the background injects again — without this guard
// that would register a second competing onMessage listener on top of the
// still-alive first one, producing duplicate overlays. No sender check is
// needed here: this extension declares no externally_connectable, so
// onMessage can only ever fire for messages from its own background/content
// contexts, never another extension or a web page.
if (!window.__fontciaOverlayInjected) {
  window.__fontciaOverlayInjected = true;

  chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number }) => {
    if (message?.type === 'ARM_SELECTION' && typeof message.tabId === 'number') {
      armSelectionMode(message.tabId);
    } else if (message?.type === 'DISMISS_SELECTION') {
      dismissSelection();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && THEME_STORAGE_KEY in changes) {
      void applyStoredTheme();
    }
  });
}
