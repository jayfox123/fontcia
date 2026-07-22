import type { Rect } from '../shared/selection-box';

export interface ScanSource {
  url: string;
  label: string;
  votes: number;
}

export interface MatchResult {
  status: 'match';
  fontName: string;
  confidence: number;
  sources: ScanSource[];
}

export interface NoMatchResult {
  status: 'no-match';
}

export type ScanResult = MatchResult | NoMatchResult;

export const NO_MATCH_WIDTH_THRESHOLD_PX = 80;
export const MOCK_SCAN_DELAY_MS = 700;

const MOCK_MATCH_FIXTURE: Omit<MatchResult, 'status'> = {
  fontName: 'Inter',
  confidence: 92,
  sources: [
    { url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 14 },
    { url: 'https://rsms.me/inter/', label: 'Official site', votes: 6 },
  ],
};

export function mockScan(rect: Rect, delayMs: number = MOCK_SCAN_DELAY_MS): Promise<ScanResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (rect.width < NO_MATCH_WIDTH_THRESHOLD_PX) {
        resolve({ status: 'no-match' });
      } else {
        resolve({ status: 'match', ...MOCK_MATCH_FIXTURE });
      }
    }, delayMs);
  });
}
