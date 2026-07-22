import { clearSelectionActive } from '../shared/session-state';
import { themeCss } from './theme';

let currentTabId: number | null = null;
let hostEl: HTMLDivElement | null = null;
let shadowSurface: HTMLDivElement | null = null;

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    dismissSelection();
  }
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

  document.addEventListener('keydown', handleKeydown);
}

function teardownOverlay(): void {
  document.removeEventListener('keydown', handleKeydown);
  hostEl?.remove();
  hostEl = null;
  shadowSurface = null;
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
