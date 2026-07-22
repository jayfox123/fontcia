import { clearSelectionActive } from '../shared/session-state';
import { normalizeDragRect, isNoOpDrag, type Point } from '../shared/selection-box';
import { renderLockedSelection } from './locked-selection';
import { themeCss } from './theme';

let currentTabId: number | null = null;
let hostEl: HTMLDivElement | null = null;
let shadowSurface: HTMLDivElement | null = null;
let draftBox: HTMLDivElement | null = null;
let dragStart: Point | null = null;
let isDragging = false;

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    dismissSelection();
  }
}

function handleMouseDown(event: MouseEvent): void {
  if (!shadowSurface) return;
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

  renderLockedSelection(shadowSurface, rect, dismissSelection);
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

  shadowSurface.addEventListener('mousedown', handleMouseDown);
  shadowSurface.addEventListener('mousemove', handleMouseMove);
  shadowSurface.addEventListener('mouseup', handleMouseUp);

  document.addEventListener('keydown', handleKeydown);
}

function teardownOverlay(): void {
  document.removeEventListener('keydown', handleKeydown);
  hostEl?.remove();
  hostEl = null;
  shadowSurface = null;
  draftBox = null;
  dragStart = null;
  isDragging = false;
}

export function armSelectionMode(tabId: number): void {
  currentTabId = tabId;
  createOverlay();
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
