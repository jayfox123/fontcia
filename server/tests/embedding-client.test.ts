import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEmbedding } from '../src/lib/embedding-client';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getEmbedding', () => {
  it('posts the image buffer as multipart form data and returns the embedding', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });

    const result = await getEmbedding(Buffer.from('fake image bytes'));

    expect(result).toEqual([0.1, 0.2, 0.3]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8000/embed');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('throws a clear error when the embedding service responds with a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Invalid image' }),
    });

    await expect(getEmbedding(Buffer.from('bad'))).rejects.toThrow('Embedding service returned 400: Invalid image');
  });
});
