import { env } from '../env';

export async function getEmbedding(imageBuffer: Buffer): Promise<number[]> {
  const formData = new FormData();
  formData.append('image', new Blob([imageBuffer]), 'crop.png');

  const res = await fetch(`${env.EMBEDDING_SERVICE_URL}/embed`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(`Embedding service returned ${res.status}: ${body?.detail ?? 'unknown error'}`);
  }

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}
