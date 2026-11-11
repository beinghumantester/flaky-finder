import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFailures, parseLog } from "../src/parser.js";
import { mergeObservations } from "../src/merge.js";
import type { Failure } from "../src/types.js";

// Step 6: every extractor runs, observations are merged in log order, overlaps are
// resolved, structurally repeated reports are merged, and a log nothing recognized
// becomes one unknown observation. Rules: docs/design/failure-evidence-boundaries.md,
// sections "When extractors overlap", "Duplicate removal" and "Unknown formats".

function log(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

const PW_ITEM = "  1) [chromium] › login.spec.ts:10:5 › user can log in";
const PY_SUMMARY = "=========================== short test summary info ============================";

// ---- several frameworks in one log ----

test("a pytest failure and a separate Playwright failure in one log are both extracted, in log order", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   boom",
      PY_SUMMARY,
      "FAILED test_a",
      "",
      PW_ITEM,
      "    Error: x",
      "  1 failed",
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.framework, f.testName, f.extraction?.span]),
    [
      ["pytest", "test_a", { startLine: 2, endLine: 3 }],
      ["playwright", "[chromium] › login.spec.ts:10:5 › user can log in", { startLine: 7, endLine: 8 }],
    ],
  );
});

test("a Playwright item printed inside a pytest failure is output of that failure: one observation, and a diagnostic", () => {
  const { failures, diagnostics } = extractFailures(
    log("=== FAILURES ===", "___ test_a ___", "E   boom", PW_ITEM, "    Error: x", "  1 failed", PY_SUMMARY),
  );
  assert.deepEqual(
    failures.map((f) => [f.framework, f.extraction?.boundary]),
    [["pytest", "complete"]],
  );
  const d = diagnostics.find((x) => x.code === "nested-observation");
  assert.equal(d?.line, 4);
  assert.match(d?.message ?? "", /line 2/);
});

test("a truncated observation that starts inside a complete one is nested, because its end was never observed", () => {
  // The Jest block has no end marker here, so it runs to the end of the log and would
  // otherwise look like a partial overlap with the pytest block.
  const { failures } = extractFailures(
    log("=== FAILURES ===", "___ test_a ___", "FAIL a.test.js", "  ● A › fails", PY_SUMMARY),
  );
  assert.deepEqual(
    failures.map((f) => [f.framework, f.extraction?.boundary]),
    [["pytest", "complete"]],
  );
});

test("two complete observations that partly overlap are both kept, both unknown, with a diagnostic", () => {
  // pytest's block ends at the section line (6); the Playwright item ends at the count line (7).
  const { failures, diagnostics } = extractFailures(
    log("=== FAILURES ===", "___ test_a ___", "E   boom", PW_ITEM, "    Error: x", PY_SUMMARY, "  1 failed"),
  );
  assert.deepEqual(
    failures.map((f) => [f.framework, f.extraction?.boundary]),
    [
      ["pytest", "unknown"],
      ["playwright", "unknown"],
    ],
  );
  assert.equal(diagnostics.find((x) => x.code === "overlapping-observations")?.line, 4);
});

test("the merge result does not depend on the order the extractors ran in", () => {
  const mk = (framework: Failure["framework"], name: string, start: number, end: number): Failure => ({
    testName: name,
    framework,
    rawText: name,
    segments: [{ startLine: start, endLine: end, text: name }],
    extraction: { method: "t", boundary: "complete", span: { startLine: start, endLine: end }, phase: "unknown" },
  });
  const a = mk("pytest", "a", 1, 5);
  const b = mk("playwright", "b", 3, 3);
  const c = mk("jest", "c", 8, 9);
  const one = mergeObservations([a, b, c], []);
  const two = mergeObservations([c, b, a], []);
  assert.deepEqual(one.failures, two.failures);
  assert.deepEqual(
    one.failures.map((f) => f.testName),
    ["a", "c"],
  );
});

// ---- pytest reprints: merged only on structural evidence ----

const CLOSE = "===================== 2 failed, 10 passed in 1.00s =====================";
const SESSION = "============================= test session starts ==============================";
const BLOCK_A = ["___ test_a ___", "E   AssertionError: a"];
const BLOCK_B = ["___ test_b ___", "E   AssertionError: b"];

test("a FAILURES section printed again after the closing line, with no new session start and an identical closing line, is merged", () => {
  const { failures, diagnostics } = extractFailures(
    log(SESSION, "=== FAILURES ===", ...BLOCK_A, ...BLOCK_B, CLOSE, "=== FAILURES ===", ...BLOCK_A, ...BLOCK_B, CLOSE),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.span.startLine]),
    [
      ["test_a", 3],
      ["test_b", 5],
    ],
  );
  const dups = diagnostics.filter((d) => d.code === "duplicate-failure-block");
  assert.deepEqual(
    dups.map((d) => d.line),
    [9, 11],
  );
  assert.match(dups[0].message, /line 3/);
});

test("a reprint whose closing line differs, for example in duration, is not merged: both copies stay, marked possible-duplicate", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      SESSION,
      "=== FAILURES ===",
      ...BLOCK_A,
      CLOSE,
      "=== FAILURES ===",
      ...BLOCK_A,
      CLOSE.replace("1.00s", "1.01s"),
    ),
  );
  assert.equal(failures.length, 2);
  assert.deepEqual(
    diagnostics.filter((d) => d.code === "possible-duplicate").map((d) => d.line),
    [7],
  );
});

test("the same test failing identically in two sessions is two observations, with no duplicate diagnostic", () => {
  const { failures, diagnostics } = extractFailures(
    log(SESSION, "=== FAILURES ===", ...BLOCK_A, CLOSE, SESSION, "=== FAILURES ===", ...BLOCK_A, CLOSE),
  );
  assert.equal(failures.length, 2);
  assert.equal(diagnostics.filter((d) => /duplicate/.test(d.code)).length, 0);
});

test("identical blocks with no closing line between them are both kept and marked possible-duplicate", () => {
  const { failures, diagnostics } = extractFailures(
    log("=== FAILURES ===", ...BLOCK_A, "=== FAILURES ===", ...BLOCK_A, PY_SUMMARY),
  );
  assert.equal(failures.length, 2);
  assert.equal(diagnostics.find((d) => d.code === "possible-duplicate")?.line, 5);
});

test("a reprint merge compares context too: a copy whose captured output differs is not a reprint", () => {
  const { failures } = extractFailures(
    log(
      SESSION,
      "=== FAILURES ===",
      ...BLOCK_A,
      "--- Captured stdout call ---",
      "first",
      CLOSE,
      "=== FAILURES ===",
      ...BLOCK_A,
      "--- Captured stdout call ---",
      "second",
      CLOSE,
    ),
  );
  assert.equal(failures.length, 2);
});

// ---- Jest summary entries ----

test("a Jest summary entry repeating an earlier failure is merged into it, with a diagnostic", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      "FAIL src/a.test.js",
      "  ● A › fails",
      "    boom",
      "PASS src/b.test.js",
      "Summary of all failing tests",
      " FAIL src/a.test.js",
      "  ● A › fails",
      "    boom",
      "Test Suites: 1 failed, 2 total",
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.span.startLine]),
    [["A › fails", 2]],
  );
  assert.equal(diagnostics.find((d) => d.code === "duplicate-failure-block")?.line, 7);
});

test("a Jest summary entry with no earlier failure to repeat is kept as its own failure", () => {
  const { failures, diagnostics } = extractFailures(
    log("Summary of all failing tests", " FAIL src/a.test.js", "  ● A › fails", "    boom", "Test Suites: 1 failed"),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.method]),
    [["A › fails", "jest-summary-entry"]],
  );
  assert.equal(diagnostics.filter((d) => /duplicate/.test(d.code)).length, 0);
});

test("two identical Playwright items are both kept and marked possible-duplicate", () => {
  const { failures, diagnostics } = extractFailures(
    log(PW_ITEM, "    Error: x", PW_ITEM, "    Error: x", "  2 failed"),
  );
  assert.equal(failures.length, 2);
  assert.equal(diagnostics.find((d) => d.code === "possible-duplicate")?.line, 3);
});

// ---- unknown formats ----

test("a log nothing recognized is one generic observation with boundary unknown covering the whole log", () => {
  const { failures } = extractFailures(log("npm install", "read ECONNRESET", "exit 1"));
  assert.equal(failures.length, 1);
  const [f] = failures;
  assert.equal(f.framework, "generic");
  assert.equal(f.testName, "unrecognized-log-format");
  assert.deepEqual(f.extraction, {
    method: "unknown-format",
    boundary: "unknown",
    span: { startLine: 1, endLine: 3 },
    phase: "unknown",
  });
  assert.deepEqual(f.segments, [{ startLine: 1, endLine: 3, text: "npm install\nread ECONNRESET\nexit 1" }]);
  assert.equal(f.rawText, "npm install\nread ECONNRESET\nexit 1");
});

test("an empty log is one unknown observation with no evidence, and invents nothing", () => {
  const { failures } = extractFailures("");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].extraction?.boundary, "unknown");
  assert.deepEqual(failures[0].segments, []);
  assert.equal(failures[0].rawText, "");
});

test("diagnostics come out ordered by line, whichever extractor produced them", () => {
  const { diagnostics } = extractFailures(
    log(
      "PASS a.test.js",
      "  ● Console",
      "    x",
      "    124) echo shell",
      "=== FAILURES ===",
      "___ t ___",
      "E   boom",
      PY_SUMMARY,
    ),
  );
  const lines = diagnostics.map((d) => d.line ?? 0);
  assert.deepEqual(
    lines,
    [...lines].sort((a, b) => a - b),
  );
  assert.ok(lines.length >= 2);
});

test("extractFailures and parseLog return the same failures", () => {
  const text = log("=== FAILURES ===", ...BLOCK_A, PY_SUMMARY, PW_ITEM, "    Error: x", "  1 failed");
  assert.deepEqual(parseLog(text), extractFailures(text).failures);
});

// Review of 6796940, P1: a Jest test's testName (describe › test) is not unique
// across files — two suites can describe the same scenario. The summary entry
// merge must use the FAIL file that preceded each bullet, not the test name alone.
test("a Jest summary entry merges into the failure from its own file, not into an earlier failure in a different file with the same test name", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      "FAIL src/users.test.js",
      "  ● User › should return a user",
      "    expected id 1, got undefined",
      "FAIL src/orders.test.js",
      "  ● User › should return a user",
      "    expected status 200, got 500",
      "Summary of all failing tests",
      " FAIL src/orders.test.js",
      "  ● User › should return a user",
      "    expected status 200, got 500",
      "Test Suites: 2 failed, 2 total",
    ),
  );
  assert.equal(failures.length, 2);
  assert.ok(
    failures.find((f) => f.rawText.includes("expected id 1, got undefined")),
    "the users.test.js failure must survive, untouched by the orders.test.js summary entry",
  );
  assert.ok(
    failures.find((f) => f.rawText.includes("expected status 200, got 500")),
    "the orders.test.js failure must survive",
  );
  const dup = diagnostics.find((d) => d.code === "duplicate-failure-block");
  assert.equal(dup?.line, 9, "the merged copy is the orders.test.js summary entry, at its own line");
});

test("a Jest summary entry with no earlier failure in its own file is kept as its own failure, even if another file has the same test name", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      "FAIL src/users.test.js",
      "  ● User › should return a user",
      "    expected id 1, got undefined",
      "Summary of all failing tests",
      " FAIL src/orders.test.js",
      "  ● User › should return a user",
      "    expected status 200, got 500",
      "Test Suites: 2 failed, 2 total",
    ),
  );
  assert.equal(failures.length, 2);
  assert.equal(diagnostics.filter((d) => /duplicate/.test(d.code)).length, 0);
});
