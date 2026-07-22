function keyFor(tabId: number): string {
  return `fontcia-active:${tabId}`;
}

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
