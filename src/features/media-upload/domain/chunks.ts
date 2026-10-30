/** Half-open byte ranges [start, end) that cover a file in order. */
export interface ByteRange {
  start: number;
  end: number;
}

export function chunkRanges(size: number, chunkSize: number): ByteRange[] {
  if (size <= 0 || chunkSize <= 0) return [];
  const ranges: ByteRange[] = [];
  for (let start = 0; start < size; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, size) });
  }
  return ranges;
}

/** Cloudinary's chunk header: inclusive end, total size. */
export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end - 1}/${size}`;
}

/** Overall progress (0-100) while providers upload at the same time: the mean of their fractions. */
export function combinedProgress(fractions: readonly number[]): number {
  if (fractions.length === 0) return 0;
  const sum = fractions.reduce((total, fraction) => total + Math.min(Math.max(fraction, 0), 1), 0);
  return Math.round((sum / fractions.length) * 100);
}
