import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { startEnrollment, captureSampleBlob } from '../src/content/enrollment';
import type { CaptureResponse } from '../src/shared/capture-messages';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('startEnrollment', () => {
  it('fetches pending submissions and renders the form with them as suggestions', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
      }
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const suggestion = body.querySelector('.fontcia-suggestion-item');
    expect(suggestion?.textContent).toContain('Brandon Grotesque');
  });

  it('renders the form with no suggestions when GET_PENDING_SUBMISSIONS fails', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: false, error: 'Not logged in' };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    expect(body.querySelector('.fontcia-input')).not.toBeNull();
  });

  it('does not render if disposed before the pending-submissions fetch resolves', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => true,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    expect(body.querySelector('.fontcia-input')).toBeNull();
  });

  it('confirms an existing submission and shows the submitted state', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
      }
      if (message.type === 'CONFIRM_FONT_SUBMISSION') {
        return { ok: true, data: { status: 'pending', confirmationCount: 2 } };
      }
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const suggestionBtn = body.querySelector('.fontcia-suggestion-item') as HTMLButtonElement;
    suggestionBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CONFIRM_FONT_SUBMISSION',
      id: 'sub-1',
      sourceUrl: null,
    });
    expect(body.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('confirms an existing submission with a proposed sourceUrl when one was typed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
      }
      if (message.type === 'CONFIRM_FONT_SUBMISSION') {
        return { ok: true, data: { status: 'pending', confirmationCount: 2 } };
      }
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'brandon';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'https://fonts.adobe.com/fonts/brandon-grotesque';

    const suggestionBtn = body.querySelector('.fontcia-suggestion-item') as HTMLButtonElement;
    suggestionBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CONFIRM_FONT_SUBMISSION',
      id: 'sub-1',
      sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque',
    });
  });

  it('shows the enrollment error state when confirming fails', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
      }
      if (message.type === 'CONFIRM_FONT_SUBMISSION') {
        return { ok: false, error: 'Pending submission not found' };
      }
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const suggestionBtn = body.querySelector('.fontcia-suggestion-item') as HTMLButtonElement;
    suggestionBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.textContent).toContain('Something went wrong submitting this.');
  });

  it('submits a new font using the provided getSampleBlob strategy', async () => {
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      if (message.type === 'SUBMIT_FONT') return { status: 'ok', submissionId: 'sub-1' };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: fakeBlob }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';
    inputs[1].value = 'https://example.com';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SUBMIT_FONT',
      fontName: 'New Font Name',
      sourceUrl: 'https://example.com',
      blob: fakeBlob,
    });
    expect(body.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('renders the capture-blocked state when getSampleBlob resolves blocked', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'blocked' }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
  });

  it('renders the enrollment error state when getSampleBlob itself resolves an error', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'error', message: 'capture failed' }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.textContent).toContain('Something went wrong submitting this.');
  });

  it('calls onCancel when Cancel is clicked', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({ ok: true, data: [] }));
    const onCancel = vi.fn();

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel,
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const cancelBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('captureSampleBlob', () => {
  it('sends CAPTURE_SELECTION and maps a captured response to ok', async () => {
    const fakeBlob = new Blob(['fake']);
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ status: 'captured', blob: fakeBlob } as CaptureResponse);

    const result = await captureSampleBlob({ x: 0, y: 0, width: 10, height: 10 }, 1);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      devicePixelRatio: 1,
    });
    expect(result).toEqual({ status: 'ok', blob: fakeBlob });
  });

  it('maps a blocked response to blocked', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ status: 'blocked' } as CaptureResponse);

    const result = await captureSampleBlob({ x: 0, y: 0, width: 10, height: 10 }, 1);

    expect(result).toEqual({ status: 'blocked' });
  });

  it('maps an error response to error', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({
      status: 'error',
      message: 'capture failed',
    } as CaptureResponse);

    const result = await captureSampleBlob({ x: 0, y: 0, width: 10, height: 10 }, 1);

    expect(result).toEqual({ status: 'error', message: 'capture failed' });
  });
});
