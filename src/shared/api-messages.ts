import type { ScanSource } from '../content/scan-types';

export type ApiMessage =
  | { type: 'SIGNUP'; email: string; password: string }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'SAVE_FONT'; fontName: string; confidence: number; sources: ScanSource[] }
  | { type: 'DELETE_SAVED_FONT'; id: string }
  | { type: 'LOG_SCAN'; status: 'match' | 'no-match'; fontName?: string; confidence?: number };

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
