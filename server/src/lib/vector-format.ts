export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
