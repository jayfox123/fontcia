import type { ScanSource } from '../content/scan-types';

export interface RankedMatch {
  fontName: string;
  confidence: number;
  sources: ScanSource[];
}

export interface MatchImageMessage {
  type: 'MATCH_IMAGE';
  blob: Blob;
}

export type MatchImageResponse =
  | { status: 'ok'; matches: RankedMatch[] }
  | { status: 'error'; message: string };
