import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

const FIXTURE_HTML = `
  <nav id="tabNav">
    <button id="tabAccount" type="button" class="fontcia-tab-btn">Account</button>
    <button id="tabSavedFonts" type="button" class="fontcia-tab-btn">Saved Fonts</button>
    <button id="tabHistory" type="button" class="fontcia-tab-btn">History</button>
    <button id="tabSettings" type="button" class="fontcia-tab-btn">Settings</button>
  </nav>
  <main id="viewContainer"></main>
`;

let chromeMock: ReturnType<typeof createChromeMock>;

async function loadAccountPage(): Promise<void> {
  document.body.innerHTML = FIXTURE_HTML;
  vi.resetModules();
  await import('../src/account/account');
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
    if (message.type === 'GET_SAVED_FONTS') return { ok: true, data: [] };
    if (message.type === 'GET_SCANS') return { ok: true, data: [] };
    return { ok: true, data: null };
  });
});

describe('account page', () => {
  it('renders the Account tab by default', async () => {
    await loadAccountPage();

    expect(document.querySelector('#viewContainer form')).not.toBeNull();
    expect(document.getElementById('tabAccount')?.classList.contains('tab-active')).toBe(true);
  });

  it('switches to the Saved Fonts view when that tab is clicked', async () => {
    await loadAccountPage();

    (document.getElementById('tabSavedFonts') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).toContain('Log in to see your saved fonts.');
    expect(document.getElementById('tabSavedFonts')?.classList.contains('tab-active')).toBe(true);
    expect(document.getElementById('tabAccount')?.classList.contains('tab-active')).toBe(false);
  });

  it('switches to the History view when that tab is clicked', async () => {
    await loadAccountPage();

    (document.getElementById('tabHistory') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).toContain('Log in to see your scan history.');
  });

  it('switches to the Settings view when that tab is clicked, reachable while logged out', async () => {
    await loadAccountPage();

    (document.getElementById('tabSettings') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).toContain('Theme');
    expect(document.getElementById('viewContainer')?.textContent).toContain('Not logged in');
  });

  it("navigates back to the Account tab when a gated view's login prompt is clicked", async () => {
    await loadAccountPage();

    (document.getElementById('tabSavedFonts') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    (document.querySelector('#viewContainer button') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('#viewContainer form')).not.toBeNull();
    expect(document.getElementById('tabAccount')?.classList.contains('tab-active')).toBe(true);
  });

  it('applies the stored theme to the document root on load', async () => {
    chromeMock = createChromeMock();
    (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
    await chromeMock.storage.local.set({ 'fontcia-theme': 'light' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });

    await loadAccountPage();

    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
  });

  it("does not paint a stale view when switching tabs before the previous view's fetch resolves", async () => {
    let resolveSavedFonts!: (value: { ok: true; data: unknown[] }) => void;
    const savedFontsPromise = new Promise((resolve) => {
      resolveSavedFonts = resolve;
    });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') return savedFontsPromise;
      if (message.type === 'GET_SCANS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    await loadAccountPage();

    (document.getElementById('tabSavedFonts') as HTMLButtonElement).click();
    await Promise.resolve();
    (document.getElementById('tabHistory') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    resolveSavedFonts({ ok: true, data: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('viewContainer')?.textContent).not.toContain("haven't saved");
  });
});
