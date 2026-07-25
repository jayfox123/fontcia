import type { Rect } from './selection-box';

export interface CaptureSelectionMessage {
  type: 'CAPTURE_SELECTION';
  rect: Rect;
  devicePixelRatio: number;
}

export type CaptureResponse =
  | { status: 'captured'; blob: Blob }
  | { status: 'blocked' }
  | { status: 'error'; message: string };
