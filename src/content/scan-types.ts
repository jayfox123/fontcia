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
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
}

export type ScanResult = MatchResult | NoMatchResult;
