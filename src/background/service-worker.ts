import { isSelectionActive, markSelectionActive } from '../shared/session-state';

const CONTENT_SCRIPT_FILE = 'content/overlay.js';

// chrome.storage.session defaults to the TRUSTED_CONTEXTS access level, which blocks
// content scripts from reading/writing it at all. Grant the broader access level once
// at module load so the content script's later calls into session-state.ts don't throw.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((error: unknown) => console.error('fontCIA: setAccessLevel failed', error));

export async function handleIconClick(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

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
