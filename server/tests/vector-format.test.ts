import { describe, it, expect } from 'vitest';
import { toVectorLiteral } from '../src/lib/vector-format';

describe('toVectorLiteral', () => {
  it('formats a number array as a pgvector literal string', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('formats an empty array', () => {
    expect(toVectorLiteral([])).toBe('[]');
  });

  it('formats negative and integer values correctly', () => {
    expect(toVectorLiteral([-1, 0, 1.5])).toBe('[-1,0,1.5]');
  });
});
