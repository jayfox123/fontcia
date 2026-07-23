import type { ScanSource } from './scan-types';

export interface KnownFont {
  name: string;
  matchKeys: string[];
  license: string;
  sources: ScanSource[];
}

function googleFontsSource(slug: string, votes: number): ScanSource {
  return { url: `https://fonts.google.com/specimen/${slug}`, label: 'Google Fonts', votes };
}

const OFL = 'SIL Open Font License 1.1';

export const KNOWN_FONTS: KnownFont[] = [
  { name: 'Inter', matchKeys: ['inter'], license: OFL, sources: [googleFontsSource('Inter', 1)] },
  { name: 'Roboto', matchKeys: ['roboto'], license: 'Apache License 2.0', sources: [googleFontsSource('Roboto', 1)] },
  { name: 'Open Sans', matchKeys: ['open sans'], license: OFL, sources: [googleFontsSource('Open+Sans', 1)] },
  { name: 'Lato', matchKeys: ['lato'], license: OFL, sources: [googleFontsSource('Lato', 1)] },
  { name: 'Montserrat', matchKeys: ['montserrat'], license: OFL, sources: [googleFontsSource('Montserrat', 1)] },
  { name: 'Poppins', matchKeys: ['poppins'], license: OFL, sources: [googleFontsSource('Poppins', 1)] },
  { name: 'Nunito', matchKeys: ['nunito'], license: OFL, sources: [googleFontsSource('Nunito', 1)] },
  {
    name: 'Source Sans Pro',
    matchKeys: ['source sans pro', 'source sans 3'],
    license: OFL,
    sources: [googleFontsSource('Source+Sans+Pro', 1)],
  },
  {
    name: 'Playfair Display',
    matchKeys: ['playfair display'],
    license: OFL,
    sources: [googleFontsSource('Playfair+Display', 1)],
  },
  { name: 'Merriweather', matchKeys: ['merriweather'], license: OFL, sources: [googleFontsSource('Merriweather', 1)] },
];

export function findKnownFont(fontFamilyStack: string): KnownFont | null {
  const candidates = fontFamilyStack
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, '').toLowerCase());

  for (const candidate of candidates) {
    const found = KNOWN_FONTS.find((font) => font.matchKeys.includes(candidate));
    if (found) return found;
  }

  return null;
}
