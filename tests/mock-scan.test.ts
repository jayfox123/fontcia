import { describe, it, expect } from 'vitest';
import { mockScan, NO_MATCH_WIDTH_THRESHOLD_PX } from '../src/content/mock-scan';

describe('mockScan', () => {
  it('resolves no-match for a rect narrower than the threshold', async () => {
    const result = await mockScan({ x: 0, y: 0, width: NO_MATCH_WIDTH_THRESHOLD_PX - 1, height: 20 }, 1);
    expect(result).toEqual({ status: 'no-match' });
  });

  it('resolves match for a rect at or above the threshold', async () => {
    const result = await mockScan({ x: 0, y: 0, width: NO_MATCH_WIDTH_THRESHOLD_PX, height: 20 }, 1);
    expect(result.status).toBe('match');
  });

  it('includes a non-empty sources array on match', async () => {
    const result = await mockScan({ x: 0, y: 0, width: 200, height: 20 }, 1);
    if (result.status !== 'match') throw new Error('expected match');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]).toHaveProperty('url');
    expect(result.sources[0]).toHaveProperty('label');
    expect(result.sources[0]).toHaveProperty('votes');
  });

  it('does not resolve before the delay elapses', async () => {
    let resolved = false;
    void mockScan({ x: 0, y: 0, width: 200, height: 20 }, 20).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resolved).toBe(true);
  });
});
