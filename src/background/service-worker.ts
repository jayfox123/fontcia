import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import {
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
  getSavedFonts,
  getScans,
} from './api-client';
import { captureAndCropSelection } from './image-capture';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse } from '../shared/match-messages';
import type { SubmitFontMessage, SubmitFontResponse } from '../shared/submission-messages';

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
      case 'GET_PENDING_SUBMISSIONS':
        return await getPendingSubmissions();
      case 'CONFIRM_FONT_SUBMISSION':
        return await confirmFontSubmission(message.id, message.sourceUrl);
      case 'RESOLVE_FONT_NAME':
        return await resolveFontName(message.fontFamilyStack);
      case 'GET_SAVED_FONTS':
        return await getSavedFonts();
      case 'GET_SCANS':
        return await getScans();
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

export async function handleCaptureMessage(
  message: CaptureSelectionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureResponse> {
  const windowId = sender.tab?.windowId;
  if (windowId === undefined) {
    console.warn('fontCIA: capture message has no windowId', sender);
    return { status: 'error', message: 'Unable to determine window for capture' };
  }
  return captureAndCropSelection(windowId, message.rect, message.devicePixelRatio);
}

export async function handleMatchImageMessage(message: MatchImageMessage): Promise<MatchImageResponse> {
  try {
    const result = await matchImage(message.blob);
    if (result.ok) {
      return { status: 'ok', matches: result.data };
    }
    return { status: 'error', message: result.error };
  } catch (error) {
    // matchImage's fetch() call isn't wrapped internally — a network failure
    // (offline, server down, DNS error) throws rather than resolving to
    // {ok: false}. Same hazard handleApiMessage's catch block documents: an
    // uncaught rejection here means sendResponse never gets called, and the
    // content script hangs until Chrome reports a port-closed error instead
    // of a clean error response.
    console.error('fontCIA: handleMatchImageMessage failed', error);
    return { status: 'error', message: 'Network error — please try again' };
  }
}

export async function handleSubmitFontMessage(message: SubmitFontMessage): Promise<SubmitFontResponse> {
  try {
    const result = await submitFont(message.fontName, message.sourceUrl, message.blob);
    if (result.ok) {
      return { status: 'ok', submissionId: result.data.submissionId };
    }
    return { status: 'error', message: result.error };
  } catch (error) {
    // Same hazard handleMatchImageMessage's catch block already documents:
    // submitFont's fetch() call isn't wrapped internally, so a real network
    // failure would otherwise propagate an uncaught rejection here and hang
    // the content script waiting for a sendResponse that never comes.
    console.error('fontCIA: handleSubmitFontMessage failed', error);
    return { status: 'error', message: 'Network error — please try again' };
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: ApiMessage | CaptureSelectionMessage | MatchImageMessage | SubmitFontMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse,
  ) => {
    if (message.type === 'CAPTURE_SELECTION') {
      handleCaptureMessage(message, sender).then(sendResponse);
    } else if (message.type === 'MATCH_IMAGE') {
      handleMatchImageMessage(message).then(sendResponse);
    } else if (message.type === 'SUBMIT_FONT') {
      handleSubmitFontMessage(message).then(sendResponse);
    } else {
      handleApiMessage(message).then(sendResponse);
    }
    return true;
  },
);
