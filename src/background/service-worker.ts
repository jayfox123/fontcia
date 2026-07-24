import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan } from './api-client';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';

const CONTENT_SCRIPT_FILE = 'content/overlay.js';
const UNAVAILABLE_BADGE_DURATION_MS = 1500;

// chrome.storage.session defaults to the TRUSTED_CONTEXTS access level, which blocks
// content scripts from reading/writing it at all. Grant the broader access level once
// at module load so the content script's later calls into session-state.ts don't throw.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((error: unknown) => console.error('fontCIA: setAccessLevel failed', error));

// chrome.scripting.executeScript throws on chrome://, chrome-extension://, the
// Chrome Web Store, and other privileged pages. An allow-list of http/https
// (with the Web Store carved back out, since Chrome blocks scripting there
// too) is more robust than trying to enumerate every restricted scheme —
// Chrome has many (chrome-search:, devtools:, view-source:, chrome-error:,
// edge:, about:, file: by default, ...) and new ones can appear over time.
export function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;

  return true;
}

// Console message alone is invisible to a user without devtools open — a brief
// badge flash gives some visible feedback that the click was seen and
// intentionally ignored, rather than the extension silently doing nothing.
async function flashUnavailableBadge(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#FF6A3D' });
  await chrome.action.setBadgeText({ text: '!' });
  setTimeout(() => {
    chrome.action
      .setBadgeText({ text: '' })
      .catch((error: unknown) => console.error('fontCIA: failed to clear badge', error));
  }, UNAVAILABLE_BADGE_DURATION_MS);
}

export async function handleIconClick(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

  if (!isInjectableUrl(tab.url)) {
    console.warn('fontCIA: cannot activate on this page', tab.url);
    await flashUnavailableBadge();
    return;
  }

  const active = await isSelectionActive(tabId);

  if (active) {
    await chrome.tabs.sendMessage(tabId, { type: 'DISMISS_SELECTION' });
    return;
  }

  // Only mark the tab active once injection + arming actually succeed, so a
  // failed injection (e.g. a restricted page) can't strand the tab in a state
  // where the next click sends DISMISS_SELECTION to a listener that was never registered.
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  await chrome.tabs.sendMessage(tabId, { type: 'ARM_SELECTION', tabId });
  await markSelectionActive(tabId);
}

chrome.action.onClicked.addListener(handleIconClick);

export async function handleApiMessage(message: ApiMessage): Promise<ApiResponse<unknown>> {
  try {
    switch (message.type) {
      case 'SIGNUP':
        return await signup(message.email, message.password);
      case 'LOGIN':
        return await login(message.email, message.password);
      case 'LOGOUT':
        return await logout();
      case 'GET_AUTH_STATE':
        return await getAuthState();
      case 'SAVE_FONT':
        return await saveFont(message.fontName, message.confidence, message.sources);
      case 'DELETE_SAVED_FONT':
        return await deleteSavedFont(message.id);
      case 'LOG_SCAN':
        return await logScan(message.status, message.fontName, message.confidence);
      default:
        return { ok: false, error: 'Unknown message type' };
    }
  } catch (error) {
    // apiFetch/rawRequest only guard res.json() parsing — a network failure
    // (offline, dev server down, DNS error) throws inside fetch() itself and
    // would otherwise propagate as a rejected promise. The chrome.runtime.onMessage
    // listener below has no way to recover from a rejection (sendResponse would
    // never get called, and the caller hangs until Chrome reports a port-closed
    // error), so handleApiMessage's contract is to never reject — always resolve
    // to a valid ApiResponse, for any caller, not just the onMessage listener.
    console.error('fontCIA: handleApiMessage failed', error);
    return { ok: false, error: 'Network error — please try again' };
  }
}

chrome.runtime.onMessage.addListener((message: ApiMessage, _sender, sendResponse) => {
  handleApiMessage(message).then(sendResponse);
  return true;
});
