import { vi } from 'vitest';

export function createChromeMock() {
  const store = new Map<string, unknown>();
  const localStore = new Map<string, unknown>();
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
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (localStore.has(key)) result[key] = localStore.get(key);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) localStore.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) localStore.delete(key);
        }),
      },
      onChanged: {
        addListener: vi.fn((_fn: (changes: unknown, areaName: string) => void) => {}),
        removeListener: vi.fn((_fn: (changes: unknown, areaName: string) => void) => {}),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (message: unknown) => void) => {
          messageListeners.push(fn);
        }),
      },
      sendMessage: vi.fn(),
      getURL: vi.fn((path: string) => `chrome-extension://fake-extension-id/${path}`),
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
      setBadgeText: vi.fn(async (_details: { text: string }) => {}),
      setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => {}),
    },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;
