import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';

const FIXTURE_HTML = `
  <div id="loggedInView" hidden>
    <p id="loggedInMessage"></p>
    <button id="logoutBtn" type="button">Log out</button>
  </div>
  <div id="formView">
    <div>
      <button id="modeLoginBtn" type="button">Log in</button>
      <button id="modeSignupBtn" type="button">Sign up</button>
    </div>
    <form id="authForm">
      <input id="emailInput" type="email" placeholder="Email" required />
      <input id="passwordInput" type="password" placeholder="Password" required />
      <button id="submitBtn" type="submit">Log in</button>
    </form>
    <p id="errorMessage" hidden></p>
    <p id="successMessage" hidden></p>
  </div>
`;

let chromeMock: ReturnType<typeof createChromeMock>;

async function loadLoginPage(): Promise<void> {
  document.body.innerHTML = FIXTURE_HTML;
  vi.resetModules();
  await import('../src/login/login');
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

// Every test here (via loadLoginPage) does vi.resetModules() + a dynamic import() of
// src/login/login.ts, whose module body calls initLoginPage() on load, which itself awaits
// a GET_AUTH_STATE round trip through the mocked chrome.runtime.sendMessage. That's fast in
// isolation but under full-suite CPU contention it can take several seconds, occasionally
// exceeding Vitest's default 5000ms per-test timeout. A killed-by-timeout test doesn't cancel
// its in-flight import()/initLoginPage() promise chain (JS promises aren't cancellable) - that
// orphaned chain can go on to call the mocked sendMessage again after the *next* test's own
// mockResolvedValueOnce queue has already been set up, consuming a response meant for that
// test and producing a cascading "Cannot read properties of null/undefined" failure with no
// relation to that test's own logic (same failure class fixed for handleApiMessage in
// tests/service-worker.test.ts; see the comment there). This is why the suite-wide
// testTimeout in vitest.config.ts is set generously rather than left at Vitest's default -
// see the comment there for the other files that share this risk.
describe('login page', () => {
  it('shows the form view when GET_AUTH_STATE reports logged out', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: false } });

    await loadLoginPage();

    expect((document.getElementById('formView') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(true);
  });

  it('shows the logged-in view with the email when GET_AUTH_STATE reports logged in', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({
      ok: true,
      data: { loggedIn: true, email: 'a@example.com' },
    });

    await loadLoginPage();

    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('loggedInMessage')?.textContent).toBe('Logged in as a@example.com');
  });

  it('submits a LOGIN message by default and shows the logged-in view on success', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } }) // initial GET_AUTH_STATE
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } }); // LOGIN

    await loadLoginPage();

    (document.getElementById('emailInput') as HTMLInputElement).value = 'a@example.com';
    (document.getElementById('passwordInput') as HTMLInputElement).value = 'password123';
    (document.getElementById('authForm') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOGIN',
      email: 'a@example.com',
      password: 'password123',
    });
    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('loggedInMessage')?.textContent).toBe('Logged in as a@example.com');
  });

  it('submits a SIGNUP message after switching to sign-up mode', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });

    await loadLoginPage();

    (document.getElementById('modeSignupBtn') as HTMLButtonElement).click();
    (document.getElementById('emailInput') as HTMLInputElement).value = 'a@example.com';
    (document.getElementById('passwordInput') as HTMLInputElement).value = 'password123';
    (document.getElementById('authForm') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SIGNUP',
      email: 'a@example.com',
      password: 'password123',
    });
  });

  it('shows the error message text on a failed login', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: false, error: 'Invalid email or password' });

    await loadLoginPage();

    (document.getElementById('emailInput') as HTMLInputElement).value = 'a@example.com';
    (document.getElementById('passwordInput') as HTMLInputElement).value = 'wrongpassword';
    (document.getElementById('authForm') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorEl = document.getElementById('errorMessage') as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('Invalid email or password');
  });

  it('sends LOGOUT and returns to the form view when Log out is clicked', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } })
      .mockResolvedValueOnce({ ok: true, data: null });

    await loadLoginPage();

    expect((document.getElementById('loggedInView') as HTMLElement).hidden).toBe(false);

    (document.getElementById('logoutBtn') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOGOUT' });
    expect((document.getElementById('formView') as HTMLElement).hidden).toBe(false);
  });

  it('falls back to the form view instead of hanging when GET_AUTH_STATE rejects on load', async () => {
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error('service worker unreachable'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadLoginPage();

    expect((document.getElementById('formView') as HTMLElement).hidden).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
