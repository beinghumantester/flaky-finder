import type { BoundaryState, Diagnostic, EvidenceSegment, Failure } from "./types.js";

// The Jest extractor. Its rules are in docs/design/failure-evidence-boundaries.md,
// section "Jest". Like the pytest extractor it reads cleaned lines (one to one with
// the original log) and never reads a rule.
//
// Indentation separates real output from nested output: Jest's own tests print whole
// runs, with their own FAIL, PASS and bullet lines, indented, inside a failure. Across
// the 49 real logs, markers have 0 or 1 leading spaces, and a failure bullet at most 2.
// This is a rule for Jest only, not a general one for other runners.
// Captures the file path, so a bullet can be tied to the file it belongs to —
// testName (describe › test) alone is not unique across files.
const FAIL_RE = /^ {0,1}FAIL\s+(\S.*)$/;
const PASS_RE = /^ {0,1}PASS\s+\S/;
const SUITES_RE = /^ {0,1}Test Suites:/;
const SUMMARY_RE = /^ {0,1}Summary of all failing tests/;
const ACTIONS_MARKER_RE = /^##\[/;
const BULLET_RE = /^ {0,2}●\s+(\S.*)$/;
const CONSOLE_RE = /^Console\b/;
const VALIDATION_WARNING_RE = /^Validation Warning/;

type FileContext = "none" | "fail" | "pass";

interface OpenBlock {
  /** 0-based index of the bullet line. */
  start: number;
  name: string;
  /** "jest-summary-entry" for a bullet in `Summary of all failing tests`, which repeats an earlier failure. */
  method: "jest-fail-block" | "jest-summary-entry";
  /** The file from the FAIL line this bullet sits under, for merge.ts's identity check. */
  file: string | undefined;
}

export function extractJest(lines: string[]): { failures: Failure[]; diagnostics: Diagnostic[] } {
  const failures: Failure[] = [];
  const diagnostics: Diagnostic[] = [];
  let context: FileContext = "none";
  let inSummary = false;
  // The file named on the most recent FAIL line. A summary bullet is always preceded
  // by its own file's FAIL line (Jest prints one per entry), so this is also the
  // summary entry's own file when we're inSummary.
  let currentFile: string | undefined;
  // The bullet being read. A block that is not a failure (Console, Validation Warning,
  // a bullet with no failure context) is still "open", so that its lines are consumed
  // and cannot be attached to the failure before it.
  let block: OpenBlock | "ignored" | null = null;

  const closeBlock = (endExclusive: number, boundary: BoundaryState): void => {
    const current = block;
    block = null;
    if (current === null || current === "ignored") return;
    let end = endExclusive;
    while (end > current.start + 1 && lines[end - 1].trim() === "") end--;
    const segment: EvidenceSegment = {
      startLine: current.start + 1,
      endLine: end,
      text: lines.slice(current.start, end).join("\n"),
    };
    failures.push({
      testName: current.name,
      framework: "jest",
      rawText: segment.text,
      segments: [segment],
      ...(current.file !== undefined ? { suiteFile: current.file } : {}),
      extraction: {
        method: current.method,
        boundary,
        span: { startLine: segment.startLine, endLine: segment.endLine },
        // Jest output does not say whether a failure happened in setup, the test or teardown.
        phase: "unknown",
      },
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const bullet = BULLET_RE.exec(line);

    const isMarker =
      FAIL_RE.test(line) ||
      PASS_RE.test(line) ||
      SUITES_RE.test(line) ||
      SUMMARY_RE.test(line) ||
      ACTIONS_MARKER_RE.test(line) ||
      bullet !== null;
    if (!isMarker) continue;

    closeBlock(i, "complete");
    block = null;

    if (bullet === null) {
      const failMatch = FAIL_RE.exec(line);
      if (failMatch) {
        context = "fail";
        currentFile = failMatch[1].trim();
      } else if (PASS_RE.test(line)) {
        // The summary lists only failing files, so a PASS line means a new run has
        // started and summary mode is over.
        context = "pass";
        inSummary = false;
      } else if (SUMMARY_RE.test(line)) {
        inSummary = true;
        context = "none";
      } else {
        // Test Suites: or a ##[ marker ends everything before it.
        inSummary = false;
        context = "none";
      }
      continue;
    }

    const name = bullet[1].trim();
    if (CONSOLE_RE.test(name)) {
      diagnostics.push({
        code: "jest-console-block",
        message: "A Console block is output of a test, not a failure.",
        line: i + 1,
        text: line,
      });
      block = "ignored";
    } else if (VALIDATION_WARNING_RE.test(name)) {
      diagnostics.push({
        code: "jest-validation-warning-block",
        message: "A Validation Warning is a Jest configuration warning, not a failure.",
        line: i + 1,
        text: line,
      });
      block = "ignored";
    } else if (context === "fail" || inSummary) {
      block = { start: i, name, method: inSummary ? "jest-summary-entry" : "jest-fail-block", file: currentFile };
    } else {
      diagnostics.push({
        code: "jest-bullet-outside-fail-context",
        message: "A bullet outside a FAIL block and the failing tests summary is not treated as a failure.",
        line: i + 1,
        text: line,
      });
      block = "ignored";
    }
  }

  // The log ended while a block was still open, so its end was never seen.
  closeBlock(lines.length, "truncated");
  return { failures, diagnostics };
}
