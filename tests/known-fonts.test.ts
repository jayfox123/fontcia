import { describe, it, expect } from 'vitest';
import { findKnownFont, KNOWN_FONTS } from '../src/content/known-fonts';

describe('findKnownFont', () => {
  it('matches an exact, unquoted family name', () => {
    const found = findKnownFont('Inter');
    expect(found?.name).toBe('Inter');
  });

  it('matches case-insensitively', () => {
    const found = findKnownFont('INTER');
    expect(found?.name).toBe('Inter');
  });

  it('matches a quoted family name inside a full stack', () => {
    const found = findKnownFont('"Roboto", -apple-system, sans-serif');
    expect(found?.name).toBe('Roboto');
  });

  it('picks the first matching entry in stack order', () => {
    const found = findKnownFont('SomeUnknownFont, Lato, Roboto');
    expect(found?.name).toBe('Lato');
  });

  it('matches a font with multiple alternate matchKeys via its second alias', () => {
    const found = findKnownFont('Source Sans 3');
    expect(found?.name).toBe('Source Sans Pro');
  });

  it('returns null when nothing in the stack is known', () => {
    const found = findKnownFont('SomeUnknownFont, AnotherUnknownFont');
    expect(found).toBeNull();
  });

  it('encodes multi-word font names as +-joined slugs in source URLs', () => {
    const openSans = KNOWN_FONTS.find((f) => f.name === 'Open Sans');
    expect(openSans?.sources[0]?.url).toBe('https://fonts.google.com/specimen/Open+Sans');
  });

  it('seeds exactly the ten expected fonts', () => {
    expect(KNOWN_FONTS.map((f) => f.name)).toEqual([
      'Inter',
      'Roboto',
      'Open Sans',
      'Lato',
      'Montserrat',
      'Poppins',
      'Nunito',
      'Source Sans Pro',
      'Playfair Display',
      'Merriweather',
    ]);
  });
});
