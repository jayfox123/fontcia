// "Active" spans the full selection lifecycle (armed-undrawn, mid-drag, and locked
// with the panel showing) — clear only from the single canonical dismiss path
// (Esc / panel close / toggle-off message), never at lock time. Otherwise the
// background's double-injection guard breaks while a locked box+panel is still on screen.
function keyFor(tabId: number): string {
  return `fontcia-active:${tabId}`;
}

// chrome.storage.session defaults to the TRUSTED_CONTEXTS access level, so the
// content script's calls here will throw unless the background service worker has
// already called chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).
export async function isSelectionActive(tabId: number): Promise<boolean> {
  const key = keyFor(tabId);
  const result = await chrome.storage.session.get(key);
  return Boolean(result[key]);
}

export async function markSelectionActive(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [keyFor(tabId)]: true });
}

export async function clearSelectionActive(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyFor(tabId));
}
