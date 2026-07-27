export interface SubmitFontMessage {
  type: 'SUBMIT_FONT';
  fontName: string;
  sourceUrl: string | null;
  blob: Blob;
}

export type SubmitFontResponse =
  | { status: 'ok'; submissionId: string }
  | { status: 'error'; message: string };
