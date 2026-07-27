import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { renderHistoryView } from '../src/account/history-view';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('renderHistoryView', () => {
  it('shows a login prompt and calls onNavigateToAccount when logged out', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
      return { ok: true, data: null };
    });
    const onNavigateToAccount = vi.fn();

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, onNavigateToAccount);

    expect(container.textContent).toContain('Log in to see your scan history.');
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onNavigateToAccount).toHaveBeenCalledOnce();
  });

  it('shows an empty message when logged in with no scans', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, vi.fn());

    expect(container.textContent).toContain("You haven't scanned anything yet.");
  });

  it('renders a match row with its fontName and confidence', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') {
        return {
          ok: true,
          data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, vi.fn());

    expect(container.querySelector('.fontcia-list-row-title')?.textContent).toBe('Inter');
    expect(container.textContent).toContain('92% confidence');
  });

  it('renders a no-match row without a confidence figure', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') {
        return {
          ok: true,
          data: [{ id: 'scan-1', status: 'no-match', fontName: null, confidence: null, createdAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      return { ok: true, data: null };
    });

    const container = document.createElement('div');
    await renderHistoryView(container, () => false, vi.fn());

    expect(container.querySelector('.fontcia-list-row-title')?.textContent).toBe('No match');
    expect(container.textContent).not.toContain('% confidence');
  });

  it('does not update the DOM if isStale reports true after the scans fetch', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_SCANS') {
        return {
          ok: true,
          data: [{ id: 'scan-1', status: 'match', fontName: 'Inter', confidence: 92, createdAt: '2026-01-01T00:00:00.000Z' }],
        };
      }
      return { ok: true, data: null };
    });
    let callCount = 0;
    const isStale = () => {
      callCount += 1;
      return callCount > 1;
    };

    const container = document.createElement('div');
    await renderHistoryView(container, isStale, vi.fn());

    expect(container.querySelector('.fontcia-list-row')).toBeNull();
    expect(container.textContent).not.toContain('Inter');
  });
});
