import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderSavedFontsView } from '../src/account/saved-fonts-view';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('renderSavedFontsView', () => {
  it('shows a login prompt and calls onNavigateToAccount when logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });
    const onNavigateToAccount = vi.fn();

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, onNavigateToAccount);

    expect(container.textContent).toContain('Log in to see your saved fonts.');
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onNavigateToAccount).toHaveBeenCalledOnce();
  });

  it('shows an empty message when logged in with no saved fonts', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    expect(container.textContent).toContain("You haven't saved any fonts yet.");
  });

  it('renders each saved font with its confidence, sources, and a delete button', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') {
        return {
          ok: true,
          data: [
            {
              id: 'font-1',
              fontName: 'Inter',
              confidence: 92,
              sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
              savedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    expect(container.querySelector('.fontcia-list-row-title')?.textContent).toBe('Inter');
    expect(container.textContent).toContain('92% confidence');
    expect(container.querySelector('.fontcia-sources a')?.textContent).toBe('Google Fonts');
    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove');
    expect(deleteBtn).not.toBeUndefined();
  });

  it('removes the row on a successful delete', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') {
        return {
          ok: true,
          data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      if (message.type === 'DELETE_SAVED_FONT') return { ok: true, data: null };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove',
    ) as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'DELETE_SAVED_FONT', id: 'font-1' });
    expect(container.querySelector('.fontcia-list-row')).toBeNull();
  });

  it('re-enables the delete button and keeps the row on a failed delete', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SAVED_FONTS') {
        return {
          ok: true,
          data: [{ id: 'font-1', fontName: 'Inter', confidence: 92, sources: [], savedAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      if (message.type === 'DELETE_SAVED_FONT') return { ok: false, error: 'Saved font not found' };
      return { ok: true, data: null };
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const container = document.createElement('div');
    await renderSavedFontsView(container, () => false, vi.fn());

    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove',
    ) as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.fontcia-list-row')).not.toBeNull();
    expect(deleteBtn.disabled).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});
