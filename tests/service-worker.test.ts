import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { chromeMock as setupChromeMock } from './setup';
import { handleIconClick } from '../src/background/service-worker';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('handleIconClick', () => {
  it('arms a fresh tab: marks it active, injects the content script, sends ARM_SELECTION', async () => {
    await handleIconClick({ id: 7 } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content/overlay.js'],
    });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'ARM_SELECTION', tabId: 7 });

    const stored = await chromeMock.storage.session.get('fontcia-active:7');
    expect(stored['fontcia-active:7']).toBe(true);
  });

  it('toggles off an already-active tab instead of re-injecting', async () => {
    await chromeMock.storage.session.set({ 'fontcia-active:7': true });

    await handleIconClick({ id: 7 } as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'DISMISS_SELECTION' });
  });

  it('does nothing for a tab with no id', async () => {
    await handleIconClick({} as chrome.tabs.Tab);

    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('module load side effects', () => {
  it('grants content scripts access to chrome.storage.session on module load', () => {
    // The top-level `import '../src/background/service-worker'` above runs once,
    // the first time this test file is loaded by Vitest, against whatever
    // globalThis.chrome exists at that moment — the default mock installed by
    // tests/setup.ts (imported for its side effect via `setupChromeMock` above),
    // not the fresh per-test `chromeMock` created in beforeEach. So this assertion
    // targets the setup.ts mock, which is the one the module actually saw.
    expect(setupChromeMock.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
  });
});
