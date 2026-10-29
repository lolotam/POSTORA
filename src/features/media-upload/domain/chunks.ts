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

/** Overall progress (0-100) when providers are uploaded one after another. */
export function combinedProgress(finishedTargets: number, currentFraction: number, totalTargets: number): number {
  if (totalTargets <= 0) return 0;
  const fraction = (finishedTargets + Math.min(Math.max(currentFraction, 0), 1)) / totalTargets;
  return Math.round(fraction * 100);
}
