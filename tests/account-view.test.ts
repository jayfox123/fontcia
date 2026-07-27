import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderAccountView } from '../src/account/account-view';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('renderAccountView', () => {
  it('shows the login form when GET_AUTH_STATE reports logged out', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: false } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(form?.hidden).toBe(false);
  });

  it('shows the logged-in email when GET_AUTH_STATE reports logged in', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    expect(container.textContent).toContain('Logged in as a@example.com');
  });

  it('submits a LOGIN message by default and shows the logged-in view on success', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    (container.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'password123';
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(
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
    expect(container.textContent).toContain('Logged in as a@example.com');
  });

  it('submits a SIGNUP message after switching to sign-up mode', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: false } })
      .mockResolvedValueOnce({ ok: true, data: { user: { id: 'u1', email: 'a@example.com' } } });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    const signupBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Sign up',
    ) as HTMLButtonElement;
    signupBtn.click();
    (container.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'password123';
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(
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

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    (container.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'wrongpassword';
    (container.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorEl = container.querySelector('.fontcia-error-message') as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('Invalid email or password');
  });

  it('sends LOGOUT and returns to the form view when Log out is clicked', async () => {
    chromeMock.runtime.sendMessage
      .mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } })
      .mockResolvedValueOnce({ ok: true, data: null });

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    const logoutBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Log out',
    ) as HTMLButtonElement;
    logoutBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOGOUT' });
    expect((container.querySelector('form') as HTMLFormElement).hidden).toBe(false);
  });

  it('falls back to the form view instead of hanging when GET_AUTH_STATE rejects on load', async () => {
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error('service worker unreachable'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const container = document.createElement('div');
    await renderAccountView(container, () => false);

    expect((container.querySelector('form') as HTMLFormElement).hidden).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('does not update the DOM if isStale reports true after the initial auth check', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { loggedIn: true, email: 'a@example.com' } });

    const container = document.createElement('div');
    await renderAccountView(container, () => true);

    expect(container.textContent).not.toContain('Logged in as a@example.com');
  });
});
