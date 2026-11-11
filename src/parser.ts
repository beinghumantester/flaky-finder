import type { ExtractionResult, Failure } from "./types.js";
import { cleanLog } from "./log-cleaning.js";
import { extractJest } from "./jest-extractor.js";
import { extractPlaywright } from "./playwright-extractor.js";
import { extractPytest } from "./pytest-extractor.js";
import { mergeObservations } from "./merge.js";
import { trimBlankEnd } from "./evidence-segments.js";

/**
 * Finds the failures in a CI log, and everything it declined to treat as one. Every
 * extractor (pytest-extractor.ts, jest-extractor.ts, playwright-extractor.ts) runs on
 * every log and looks only for its own structure, so a log can contain several
 * frameworks and the order they run in does not matter. merge.ts puts the
 * observations in log order and resolves overlaps and repeated reports. A log none
 * of them recognizes becomes one `generic` observation with an unknown boundary,
 * never a guess at a split. ANSI escape codes and CI timestamp prefixes are stripped
 * first, keeping lines one to one: see log-cleaning.ts.
 */
export function extractFailures(input: string): ExtractionResult {
  const raw = cleanLog(input);
  const lines = raw.split("\n");
  const pytest = extractPytest(lines);
  const jest = extractJest(lines);
  const playwright = extractPlaywright(lines);
  const { failures, diagnostics } = mergeObservations(
    [...pytest.failures, ...jest.failures, ...playwright.failures],
    pytest.sessionMarks,
    [...pytest.diagnostics, ...jest.diagnostics, ...playwright.diagnostics],
  );
  diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (failures.length === 0) failures.push(unknownObservation(lines));
  return { failures, diagnostics };
}

// The whole log as one observation whose boundary is unknown. It keeps its text, so
// signals in it can be reported, but it can never decide a verdict.
function unknownObservation(lines: string[]): Failure {
  const end = trimBlankEnd(lines, 0, lines.length);
  const text = lines.slice(0, end).join("\n");
  return {
    testName: "unrecognized-log-format",
    framework: "generic",
    rawText: text,
    segments: end > 0 ? [{ startLine: 1, endLine: end, text }] : [],
    extraction: {
      method: "unknown-format",
      boundary: "unknown",
      span: { startLine: 1, endLine: Math.max(end, 1) },
      phase: "unknown",
    },
  };
}

// Unchanged for existing callers.
export function parseLog(input: string): Failure[] {
  return extractFailures(input).failures;
}
