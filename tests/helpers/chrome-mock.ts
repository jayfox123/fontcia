import { vi } from 'vitest';

export function createChromeMock() {
  const store = new Map<string, unknown>();
  const messageListeners: Array<(message: unknown) => void> = [];

  return {
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (store.has(key)) result[key] = store.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) store.delete(key);
        }),
        setAccessLevel: vi.fn(async () => {}),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (message: unknown) => void) => {
          messageListeners.push(fn);
        }),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        for (const fn of messageListeners) fn(message);
      }),
    },
    action: {
      onClicked: {
        addListener: vi.fn((_fn: (tab: { id: number }) => void) => {}),
      },
    },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;
