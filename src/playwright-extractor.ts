import type { BoundaryState, Diagnostic, EvidenceSegment, Failure, LineSpan } from "./types.js";

// The Playwright extractor. Its rules are in docs/design/failure-evidence-boundaries.md,
// section "Playwright". Like the other extractors it reads cleaned lines (one to one with
// the original log) and never reads a rule.

// Any "N) text" line. Whether it is a failure item is decided separately.
const NUMBERED_RE = /^\s*\d+\)\s+(\S.*)$/;
// "file.spec.ts:10:5", the location Playwright prints in an item's title.
const LOCATION_RE = /\S+:\d+:\d+/;
// "  1 failed", "  44 passed (12.2m)": the totals printed after the items.
const COUNT_RE = /^ {0,2}\d+ (?:failed|passed|skipped|flaky|did not run|interrupted|not run)\b/;
const ACTIONS_MARKER_RE = /^##\[/;
const RETRY_RE = /^\s*Retry #\d+\b/;

interface OpenItem {
  /** 0-based index of the item line. */
  start: number;
  name: string;
  /** 0-based indexes of the `Retry #N` lines. */
  retryStarts: number[];
}

function trimEnd(lines: string[], floor: number, endExclusive: number): number {
  let end = endExclusive;
  while (end > floor && lines[end - 1].trim() === "") end--;
  return end;
}

export function extractPlaywright(lines: string[]): { failures: Failure[]; diagnostics: Diagnostic[] } {
  const failures: Failure[] = [];
  const diagnostics: Diagnostic[] = [];
  let item: OpenItem | null = null;

  const closeItem = (endExclusive: number, boundary: BoundaryState): void => {
    if (!item) return;
    const { start, name, retryStarts } = item;
    item = null;
    const end = trimEnd(lines, start + 1, endExclusive);
    const segment: EvidenceSegment = { startLine: start + 1, endLine: end, text: lines.slice(start, end).join("\n") };
    // One span per attempt: the first run, then one from each `Retry #N` line. An item
    // with no retries has a single attempt, which is just the item, so none is listed.
    const edges = [start, ...retryStarts, end];
    const attempts: LineSpan[] = retryStarts.length
      ? edges.slice(0, -1).map((from, k) => {
          const to = trimEnd(lines, from + 1, edges[k + 1]);
          return { startLine: from + 1, endLine: to };
        })
      : [];
    failures.push({
      testName: name,
      framework: "playwright",
      rawText: segment.text,
      segments: [segment],
      extraction: {
        method: "playwright-failure-item",
        boundary,
        span: { startLine: segment.startLine, endLine: segment.endLine },
        // Playwright's report does not say which phase failed, so none is guessed.
        phase: "unknown",
        ...(attempts.length > 0 ? { attempts } : {}),
      },
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    if (COUNT_RE.test(line) || ACTIONS_MARKER_RE.test(line)) {
      closeItem(i, "complete");
      continue;
    }

    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      const title = numbered[1];
      if (title.includes("›") && LOCATION_RE.test(title)) {
        closeItem(i, "complete");
        item = { start: i, name: title.trim(), retryStarts: [] };
      } else {
        // A shell case such as `124) echo ...`, or a list inside an item's own text.
        diagnostics.push({
          code: "playwright-item-rejected",
          message: "A numbered line without a test title and file location is not a Playwright failure.",
          line: i + 1,
          text: line,
        });
      }
      continue;
    }

    if (item && RETRY_RE.test(line)) item.retryStarts.push(i);
  }

  // The log ended while an item was still open, so its end was never seen.
  closeItem(lines.length, "truncated");
  return { failures, diagnostics };
}
