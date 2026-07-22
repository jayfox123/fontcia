import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { isSelectionActive, markSelectionActive, clearSelectionActive } from '../src/shared/session-state';

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = createChromeMock();
});

describe('session-state', () => {
  it('is inactive for a tab that was never marked', async () => {
    await expect(isSelectionActive(1)).resolves.toBe(false);
  });

  it('becomes active after marking, and inactive after clearing', async () => {
    await markSelectionActive(1);
    await expect(isSelectionActive(1)).resolves.toBe(true);

    await clearSelectionActive(1);
    await expect(isSelectionActive(1)).resolves.toBe(false);
  });

  it('tracks each tabId independently', async () => {
    await markSelectionActive(1);
    await expect(isSelectionActive(2)).resolves.toBe(false);
  });
});
