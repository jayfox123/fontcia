import { isSelectionActive, markSelectionActive } from '../shared/session-state';

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
