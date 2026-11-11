import type { EvidenceSegment, LineSpan } from "./types.js";

// Primary evidence is whatever part of a block is not context, in log order. Each
// segment's text is exactly its lines, so a location is never calculated from the
// block's first line plus an offset: context in the middle leaves a gap, and the
// lines after it keep their own numbers. See docs/design/failure-evidence-boundaries.md.

/** Index just past the last non-blank line in [floor, endExclusive), never before floor. */
export function trimBlankEnd(lines: string[], floor: number, endExclusive: number): number {
  let end = endExclusive;
  while (end > floor && lines[end - 1].trim() === "") end--;
  return end;
}

/**
 * Splits a block into primary evidence segments around its context spans. `lines`
 * are the cleaned log lines (index 0 is line 1). Context spans must lie inside the
 * block, be in order, and not overlap. Blank lines at the end of a segment are
 * dropped from it; a segment that would be only blank lines is omitted.
 */
export function buildSegments(lines: string[], block: LineSpan, contextSpans: LineSpan[]): EvidenceSegment[] {
  const segments: EvidenceSegment[] = [];
  let from = block.startLine;
  const edges = [...contextSpans, null];
  for (const context of edges) {
    const toExclusive = context ? context.startLine : block.endLine + 1;
    // 0-based: segment covers lines[from - 1 .. toExclusive - 2].
    const end = trimBlankEnd(lines, from - 1, toExclusive - 1);
    if (end > from - 1) {
      segments.push({ startLine: from, endLine: end, text: lines.slice(from - 1, end).join("\n") });
    }
    if (context) from = context.endLine + 1;
  }
  return segments;
}
