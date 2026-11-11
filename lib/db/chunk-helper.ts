/**
 * Helper functions for handling large arrays in Prisma queries.
 * Chunks arrays to avoid exceeding Prisma query parameter limits.
 */

export function chunkArray<T>(items: T[], chunkSize = 500): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function chunkQuery<T, R>(
  items: T[],
  queryFn: (chunk: T[]) => Promise<R[]>,
  chunkSize = 500,
): Promise<R[]> {
  const chunks = chunkArray(items, chunkSize);
  const results: R[] = [];
  for (const chunk of chunks) {
    const chunkResults = await queryFn(chunk);
    results.push(...chunkResults);
  }
  return results;
}
