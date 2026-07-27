import type { Rect } from '../shared/selection-box';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { SubmitFontMessage, SubmitFontResponse } from '../shared/submission-messages';
import {
  renderEnrollmentFormState,
  renderEnrollmentSubmittedState,
  renderEnrollmentErrorState,
  renderCaptureBlockedState,
  type PendingSuggestion,
} from './scan-dialogue';

export type SampleBlobResult =
  | { status: 'ok'; blob: Blob }
  | { status: 'blocked' }
  | { status: 'error'; message: string };

export interface EnrollmentDeps {
  body: HTMLElement;
  isDisposed: () => boolean;
  onCancel: () => void;
  getSampleBlob: () => Promise<SampleBlobResult>;
}

function sendApiMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

// Wraps the same CAPTURE_SELECTION round trip the AI image path already
// established (image-capture-pipeline sub-project) — the DOM path's "Name
// it" click is just a new, on-demand trigger for it, not a new mechanism.
export function captureSampleBlob(rect: Rect, devicePixelRatio: number): Promise<SampleBlobResult> {
  const message: CaptureSelectionMessage = { type: 'CAPTURE_SELECTION', rect, devicePixelRatio };
  return chrome.runtime.sendMessage(message).then((response: CaptureResponse): SampleBlobResult => {
    if (response.status === 'captured') return { status: 'ok', blob: response.blob };
    if (response.status === 'blocked') return { status: 'blocked' };
    return { status: 'error', message: response.message };
  });
}

export async function startEnrollment(deps: EnrollmentDeps): Promise<void> {
  const { body, isDisposed, onCancel, getSampleBlob } = deps;

  let pendingSuggestions: PendingSuggestion[] = [];
  try {
    const res = await sendApiMessage<PendingSuggestion[]>({ type: 'GET_PENDING_SUBMISSIONS' });
    if (res.ok) {
      pendingSuggestions = res.data;
    }
  } catch (error: unknown) {
    console.error('fontCIA: failed to fetch pending submissions', error);
  }
  if (isDisposed()) return;

  function handleConfirmExisting(id: string): void {
    sendApiMessage<{ status: string; confirmationCount: number }>({ type: 'CONFIRM_FONT_SUBMISSION', id })
      .then((res) => {
        if (isDisposed()) return;
        if (res.ok) {
          renderEnrollmentSubmittedState(body, onCancel);
        } else {
          console.error('fontCIA: confirm submission failed', res.error);
          renderEnrollmentErrorState(body, onCancel);
        }
      })
      .catch((error: unknown) => {
        if (isDisposed()) return;
        console.error('fontCIA: confirm submission message failed', error);
        renderEnrollmentErrorState(body, onCancel);
      });
  }

  function handleSubmitNew(fontName: string, sourceUrl: string | null): void {
    getSampleBlob()
      .then((sampleResult) => {
        if (isDisposed()) return;
        if (sampleResult.status === 'blocked') {
          renderCaptureBlockedState(body, onCancel);
          return;
        }
        if (sampleResult.status === 'error') {
          console.error('fontCIA: enrollment sample capture failed', sampleResult.message);
          renderEnrollmentErrorState(body, onCancel);
          return;
        }

        const message: SubmitFontMessage = { type: 'SUBMIT_FONT', fontName, sourceUrl, blob: sampleResult.blob };
        chrome.runtime
          .sendMessage(message)
          .then((response: SubmitFontResponse) => {
            if (isDisposed()) return;
            if (response.status === 'ok') {
              renderEnrollmentSubmittedState(body, onCancel);
            } else {
              console.error('fontCIA: font submission failed', response.message);
              renderEnrollmentErrorState(body, onCancel);
            }
          })
          .catch((error: unknown) => {
            if (isDisposed()) return;
            console.error('fontCIA: submit font message failed', error);
            renderEnrollmentErrorState(body, onCancel);
          });
      })
      .catch((error: unknown) => {
        if (isDisposed()) return;
        console.error('fontCIA: enrollment sample capture message failed', error);
        renderEnrollmentErrorState(body, onCancel);
      });
  }

  renderEnrollmentFormState(body, pendingSuggestions, handleConfirmExisting, handleSubmitNew, onCancel);
}
