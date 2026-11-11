import type { Diagnostic, Failure, LineSpan } from "./types.js";

// The merge step. Every extractor runs on every log and returns observations with
// spans. This module puts them in log order, resolves overlaps between extractors,
// merges reports that the log's structure shows were printed twice, and marks
// identical blocks it cannot explain. Rules: docs/design/failure-evidence-boundaries.md,
// sections "When extractors overlap" and "Duplicate removal".

/** A region-level pytest session event: where a session started, or where its closing line is. */
export interface SessionMark {
  /** 1-based line. */
  line: number;
  kind: "start" | "close";
  /** The closing line's title, for example "3 failed, 18819 passed in 1018.95s". */
  title: string;
}

function span(f: Failure): LineSpan {
  // Every observation from an extractor carries a span; this module is never given text without one.
  return f.extraction!.span;
}

function contextText(f: Failure): string {
  return (f.extraction?.contextSpans ?? []).map((c) => c.text).join("\n\u0000");
}

/**
 * Same framework, suite file (when the extractor tracks one), test name and phase,
 * with identical primary text and context. `suiteFile` is undefined for pytest and
 * Playwright, so it compares equal between any two of their observations and adds
 * no constraint there; for Jest it stops two different files' tests that happen to
 * share a `describe` and title (review of 6796940, P1) from being treated as one.
 */
function identical(a: Failure, b: Failure): boolean {
  return (
    a.framework === b.framework &&
    a.suiteFile === b.suiteFile &&
    a.testName === b.testName &&
    a.extraction?.phase === b.extraction?.phase &&
    a.rawText === b.rawText &&
    contextText(a) === contextText(b)
  );
}

/**
 * Every line belongs to at most one observation. An observation wholly inside another
 * is output of the outer one. A truncated observation that starts inside another is
 * nested too: its end was never observed, so a partial overlap cannot be established.
 * Two complete observations that partly overlap, or that claim the exact same lines,
 * cannot both be trusted, so both become `unknown` and ineligible.
 */
function resolveOverlaps(sorted: Failure[], diagnostics: Diagnostic[]): Failure[] {
  const kept: Failure[] = [];
  let outer: Failure | null = null;
  for (const f of sorted) {
    const s = span(f);
    if (outer === null || s.startLine > span(outer).endLine) {
      kept.push(f);
      outer = f;
      continue;
    }
    const o = span(outer);
    const sameLines = s.startLine === o.startLine && s.endLine === o.endLine;
    const inside = !sameLines && (s.endLine <= o.endLine || f.extraction?.boundary === "truncated");
    if (inside) {
      diagnostics.push({
        code: "nested-observation",
        message: `A ${f.framework} failure inside the ${outer.framework} failure at line ${o.startLine} is output of that failure, not a separate one.`,
        line: s.startLine,
        text: f.segments?.[0]?.text.split("\n")[0],
      });
      continue;
    }
    for (const x of [outer, f]) x.extraction!.boundary = "unknown";
    diagnostics.push({
      code: "overlapping-observations",
      message: `A ${f.framework} failure overlaps the ${outer.framework} failure at line ${o.startLine}, so neither boundary can be trusted.`,
      line: s.startLine,
      text: f.segments?.[0]?.text.split("\n")[0],
    });
    kept.push(f);
    if (s.endLine > o.endLine) outer = f;
  }
  return kept;
}

/**
 * pytest reprint: a FAILURES or ERRORS region printed again after the session's
 * closing line, with no new session start in between, and ending with a closing line
 * identical to the first, duration included. Nothing else merges: a rerun prints a new
 * session start, and a closing line that differs means a different run.
 */
function mergePytestReprints(failures: Failure[], marks: SessionMark[], diagnostics: Diagnostic[]): Failure[] {
  const kept: Failure[] = [];
  for (const f of failures) {
    if (f.framework !== "pytest") {
      kept.push(f);
      continue;
    }
    const start = span(f).startLine;
    const closeBefore = [...marks].reverse().find((m) => m.kind === "close" && m.line < start);
    const startBetween =
      closeBefore && marks.some((m) => m.kind === "start" && m.line > closeBefore.line && m.line < start);
    const closeAfter = marks.find((m) => m.kind === "close" && m.line > start);
    const isReprint = closeBefore && !startBetween && closeAfter && closeAfter.title === closeBefore.title;
    const original = isReprint
      ? kept.find((k) => k.framework === "pytest" && span(k).startLine < closeBefore.line && identical(k, f))
      : undefined;
    if (original) {
      diagnostics.push({
        code: "duplicate-failure-block",
        message: `Repeats the block at line ${span(original).startLine}: the report was printed again after the session's closing line, with the same closing line after it.`,
        line: start,
        text: f.segments?.[0]?.text.split("\n")[0],
      });
      continue;
    }
    kept.push(f);
  }
  return kept;
}

/**
 * A Jest summary entry repeats an earlier failure's exact text by definition, under
 * the same file. `testName` alone does not identify which earlier failure that is —
 * two files can describe the same scenario with the same title — so the match also
 * requires the same `suiteFile` and identical content (review of 6796940, P1). One
 * that cannot be matched this way is kept rather than dropped on a guess; if it is
 * still byte-identical to some other kept failure, markPossibleDuplicates (below)
 * flags that instead.
 */
function mergeJestSummaryEntries(failures: Failure[], diagnostics: Diagnostic[]): Failure[] {
  const kept: Failure[] = [];
  for (const f of failures) {
    const original =
      f.extraction?.method === "jest-summary-entry"
        ? kept.find((k) => k.extraction?.method === "jest-fail-block" && identical(k, f))
        : undefined;
    if (original) {
      diagnostics.push({
        code: "duplicate-failure-block",
        message: `Repeats the failure at line ${span(original).startLine}: an entry in "Summary of all failing tests".`,
        line: span(f).startLine,
        text: f.segments?.[0]?.text.split("\n")[0],
      });
      continue;
    }
    kept.push(f);
  }
  return kept;
}

/**
 * Identical blocks that no structure explains are kept, because content alone cannot
 * tell a repeated report from a real rerun, and marked so the reader can decide. For
 * pytest, a session start between two copies is structure: separate runs, no mark.
 */
function markPossibleDuplicates(failures: Failure[], marks: SessionMark[], diagnostics: Diagnostic[]): void {
  for (let i = 0; i < failures.length; i++) {
    for (let j = 0; j < i; j++) {
      const earlier = failures[j];
      const later = failures[i];
      if (!identical(earlier, later)) continue;
      const a = span(earlier).startLine;
      const b = span(later).startLine;
      if (later.framework === "pytest" && marks.some((m) => m.kind === "start" && m.line > a && m.line < b)) continue;
      diagnostics.push({
        code: "possible-duplicate",
        message: `Identical to the block at line ${a}. The log's structure does not show whether this is a repeated report or a separate run, so both are kept.`,
        line: b,
        text: later.segments?.[0]?.text.split("\n")[0],
      });
      break;
    }
  }
}

/**
 * Merges every extractor's observations into the final list, in log order. Adds to
 * `diagnostics` everything it dropped or could not decide.
 */
export function mergeObservations(
  observations: Failure[],
  marks: SessionMark[],
  diagnostics: Diagnostic[] = [],
): { failures: Failure[]; diagnostics: Diagnostic[] } {
  const sorted = [...observations].sort(
    (a, b) => span(a).startLine - span(b).startLine || span(a).endLine - span(b).endLine,
  );
  let failures = resolveOverlaps(sorted, diagnostics);
  failures = mergePytestReprints(failures, marks, diagnostics);
  failures = mergeJestSummaryEntries(failures, diagnostics);
  markPossibleDuplicates(failures, marks, diagnostics);
  return { failures, diagnostics };
}
