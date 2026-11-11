import type { BoundaryState, ContextSpan, Diagnostic, Failure, FailurePhase, LineSpan } from "./types.js";
import { buildSegments, trimBlankEnd } from "./evidence-segments.js";
import type { SessionMark } from "./merge.js";

// The pytest extractor. Its rules are in docs/design/failure-evidence-boundaries.md,
// section "pytest". It reads cleaned lines (log-cleaning.ts keeps them one to one,
// so a line index plus one is the original line number) and never reads a rule:
// deciding which lines belong to a failure is a separate job from classifying it.

// "=== title ===". The title is what sits between the runs of "=".
const SECTION_RE = /^=+ (.+?) =+$/;
// "___ test_name ___", of any underscore length, including the short "_ ERROR collecting x _".
const HEADER_RE = /^_+ (\S.*?) _+$/;
// "-------- generated xml file: /files/result.xml --------": report output, not failure text.
const XML_RE = /^-+ generated xml file: .* -+$/;
const CAPTURED_RE = /^-+ Captured (?:stdout|stderr|log)(?: (?:setup|call|teardown))? -+$/;
// The closing line of a session: "45 failed, 2 errors in 1.84s" or "no tests ran in 0.01s".
const SUMMARY_TITLE_RE =
  /(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|rerun|deselected)|no tests ran).* in \d+(?:\.\d+)?s/;
const SESSION_START = "test session starts";
// The section titles pytest itself prints. Inside an open block only these count as
// structure: a test's own output can print "=== anything ===" (captured, or with -s),
// and that must not end the block or the region. Between blocks any title counts,
// because nothing but pytest writes there.
const KNOWN_TITLE_RE =
  /^(?:FAILURES|ERRORS|PASSES|XFAILURES|XPASSES|short test summary info|warnings summary|rerun test summary info|FLAKES\b.*|slowest \d+ durations|test session starts)$/;

function isStructuralTitle(title: string): boolean {
  return KNOWN_TITLE_RE.test(title) || SUMMARY_TITLE_RE.test(title);
}

function matchHeader(line: string): string | null {
  const name = HEADER_RE.exec(line)?.[1];
  // A traceback separator, "_ _ _ _ _", fits the header shape but names nothing.
  if (name === undefined || /^[_ ]+$/.test(name)) return null;
  return name;
}

function phaseOf(name: string): FailurePhase {
  if (name.startsWith("ERROR at setup of ")) return "setup";
  if (name.startsWith("ERROR at teardown of ")) return "teardown";
  if (name.startsWith("ERROR collecting ")) return "collection";
  return "call";
}

interface OpenBlock {
  /** 0-based index of the header line. */
  start: number;
  name: string;
  method: string;
  /** 0-based indexes of the captured-output headers, at the block's own level. */
  capturedStarts: number[];
}

export function extractPytest(lines: string[]): {
  failures: Failure[];
  diagnostics: Diagnostic[];
  /** Region-level session starts and closing lines, for the merge step's reprint rule. */
  sessionMarks: SessionMark[];
} {
  const failures: Failure[] = [];
  const diagnostics: Diagnostic[] = [];
  const sessionMarks: SessionMark[] = [];
  let region: "failures" | "errors" | null = null;
  let block: OpenBlock | null = null;
  // How many sessions are open inside the current block. pytest's own tests print
  // whole sessions as the output of one failing test, so their headers and sections
  // are output of that failure, not new failures.
  let depth = 0;

  const closeBlock = (endExclusive: number, boundary: BoundaryState): void => {
    if (!block) return;
    const { start, name, method, capturedStarts } = block;
    block = null;
    const end = trimBlankEnd(lines, start + 1, endExclusive);
    // pytest prints captured output after the traceback and nothing after it, so each
    // captured section runs to the next one or to the block's end.
    const contextSpans: ContextSpan[] = capturedStarts.map((from, k) => {
      const to = trimBlankEnd(lines, from + 1, capturedStarts[k + 1] ?? end);
      return { startLine: from + 1, endLine: to, text: lines.slice(from, to).join("\n") };
    });
    const span: LineSpan = { startLine: start + 1, endLine: end };
    const segments = buildSegments(lines, span, contextSpans);
    failures.push({
      testName: name,
      framework: "pytest",
      rawText: segments.map((seg) => seg.text).join("\n"),
      segments,
      extraction: {
        method,
        boundary,
        span,
        phase: phaseOf(name),
        ...(contextSpans.length > 0 ? { contextSpans } : {}),
      },
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const title = SECTION_RE.exec(line)?.[1];

    if (block && depth > 0) {
      // Inside a nested session everything belongs to the outer block. Only its own
      // start and closing lines matter, so that its sections cannot end the region.
      if (title === SESSION_START) depth++;
      else if (title !== undefined && SUMMARY_TITLE_RE.test(title)) depth--;
      continue;
    }

    if (title !== undefined) {
      if (block && title === SESSION_START) {
        depth = 1;
        continue;
      }
      // An unknown title inside a block is the test's own output, not structure.
      if (block && !isStructuralTitle(title)) continue;
      closeBlock(i, "complete");
      if (title === SESSION_START) sessionMarks.push({ line: i + 1, kind: "start", title });
      else if (SUMMARY_TITLE_RE.test(title)) sessionMarks.push({ line: i + 1, kind: "close", title });
      region = title === "FAILURES" ? "failures" : title === "ERRORS" ? "errors" : null;
      continue;
    }

    if (block && XML_RE.test(line)) {
      // Ends the block but not the region, so a later header is still found.
      closeBlock(i, "complete");
      continue;
    }

    const name = matchHeader(line);
    if (name !== null) {
      if (region) {
        closeBlock(i, "complete");
        block = { start: i, name, method: `pytest-${region}-section`, capturedStarts: [] };
      } else {
        diagnostics.push({
          code: "pytest-header-outside-failure-section",
          // sectionTitle comes straight from the log, so it is never interpolated
          // into this message, even though it would be useful for debugging — a
          // public diagnostic message must never carry raw log content (review of
          // 6796940, P1). The line number is enough to find the exact section in
          // the log, and `text` (internal only, see public-output.ts) already has
          // the rejected header line itself.
          message: "A header inside a non-failure pytest section is not a failure.",
          line: i + 1,
          text: line,
        });
      }
      continue;
    }

    if (block && CAPTURED_RE.test(line)) block.capturedStarts.push(i);
  }

  // The log ended while a block was still open, so its end was never seen.
  closeBlock(lines.length, "truncated");
  return { failures, diagnostics, sessionMarks };
}
