import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { cleanLog } from "../src/log-cleaning.js";
import { extractFailures, parseLog } from "../src/parser.js";

// Step 3: the pytest extractor. Rules come from docs/design/failure-evidence-boundaries.md,
// section "pytest". Small made-up logs test one rule each; the real excerpts are in
// extraction.acceptance.test.ts.

function log(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

const SUMMARY = "=========================== short test summary info ============================";

test("each failure gets its own span, header included, and evidence stops at the next header", () => {
  const { failures } = extractFailures(
    log(
      "=================================== FAILURES ===================================",
      "_______________________ test_a _______________________",
      "E   AssertionError: x",
      "_______________________ test_b _______________________",
      "E   assert 1 == 2",
      SUMMARY,
      "FAILED test_a",
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.span, f.extraction?.boundary, f.extraction?.method]),
    [
      ["test_a", { startLine: 2, endLine: 3 }, "complete", "pytest-failures-section"],
      ["test_b", { startLine: 4, endLine: 5 }, "complete", "pytest-failures-section"],
    ],
  );
  assert.equal(failures[0].rawText, "_______________________ test_a _______________________\nE   AssertionError: x");
});

test("text after the pytest summary is not attached to the last failure", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   AssertionError: x",
      SUMMARY,
      "FAILED test_a",
      "postgres-1  | ERROR:  duplicate key value violates unique constraint",
    ),
  );
  assert.equal(failures.length, 1);
  assert.ok(!failures[0].rawText.includes("duplicate key"));
});

test("a log that ends mid failure is truncated, and a block ended by a later header is complete", () => {
  const { failures } = extractFailures(
    log("=== FAILURES ===", "___ test_a ___", "E   boom", "___ test_b ___", "E   cut off here"),
  );
  assert.deepEqual(
    failures.map((f) => f.extraction?.boundary),
    ["complete", "truncated"],
  );
});

test("ERROR headers set the phase: setup, teardown, collection, and call otherwise", () => {
  const { failures } = extractFailures(
    log(
      "=== ERRORS ===",
      "___ ERROR at setup of test_s ___",
      "E   fixture failed",
      "___ ERROR at teardown of test_t ___",
      "E   cleanup failed",
      "_ ERROR collecting tests/test_x.py _",
      "E   ImportError",
      "=== FAILURES ===",
      "___ test_c ___",
      "E   assert 0",
      SUMMARY,
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.phase, f.extraction?.method]),
    [
      ["ERROR at setup of test_s", "setup", "pytest-errors-section"],
      ["ERROR at teardown of test_t", "teardown", "pytest-errors-section"],
      ["ERROR collecting tests/test_x.py", "collection", "pytest-errors-section"],
      ["test_c", "call", "pytest-failures-section"],
    ],
  );
});

test("a generated xml line ends the block but not the region, so a later header is still found", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   boom",
      "-------- generated xml file: /files/result.xml --------",
      "___ test_b ___",
      "E   bang",
      SUMMARY,
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.boundary, f.rawText.includes("generated xml")]),
    [
      ["test_a", "complete", false],
      ["test_b", "complete", false],
    ],
  );
});

test("captured output is kept as context with its own lines and text, and is not primary evidence", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   AssertionError: x",
      "",
      "------------------ Captured stdout call ------------------",
      "ConnectionResetError: Connection reset by peer",
      "------------------ Captured log call ------------------",
      "WARNING handled and retried",
      SUMMARY,
    ),
  );
  const [f] = failures;
  assert.equal(f.rawText, "___ test_a ___\nE   AssertionError: x");
  assert.deepEqual(f.segments, [{ startLine: 2, endLine: 3, text: "___ test_a ___\nE   AssertionError: x" }]);
  assert.deepEqual(f.extraction?.contextSpans, [
    {
      startLine: 5,
      endLine: 6,
      text: "------------------ Captured stdout call ------------------\nConnectionResetError: Connection reset by peer",
    },
    {
      startLine: 7,
      endLine: 8,
      text: "------------------ Captured log call ------------------\nWARNING handled and retried",
    },
  ]);
  assert.deepEqual(f.extraction?.span, { startLine: 2, endLine: 8 });
});

test("`_ _ _ _` traceback separators are not headers", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "x.py:1: in f",
      "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _",
      "y.py:2: in g",
      "E   boom",
      SUMMARY,
    ),
  );
  assert.equal(failures.length, 1);
  assert.ok(failures[0].rawText.includes("y.py:2"));
});

test("a header outside a FAILURES or ERRORS section creates no observation and is reported with its line", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   boom",
      "=========================== FLAKES (original error) ============================",
      "___ test_a ___",
      "E   first attempt",
    ),
  );
  assert.equal(failures.length, 1);
  const d = diagnostics.find((x) => x.code === "pytest-header-outside-failure-section");
  assert.equal(d?.line, 5);
  assert.equal(d?.text, "___ test_a ___");
  // Review of 6796940, P1: the message used to name the enclosing section
  // ("the FLAKES (original error) section"), built straight from log content. A
  // public diagnostic message must never carry raw log content, so it is now
  // static; `code` and `line` already say enough to find the exact section.
  assert.equal(d?.message, "A header inside a non-failure pytest section is not a failure.");
});

// ---- nested sessions ----

const NESTED_START = "============================= test session starts ==============================";

test("several nested sessions inside one failure create no observations, whatever markers they print", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_outer ___",
      "E   inner run failed",
      "----------------- Captured stdout call -----------------",
      NESTED_START,
      "=== ERRORS ===",
      "___ ERROR at setup of test_inner ___",
      "=== FAILURES ===",
      "___ test_inner ___",
      SUMMARY,
      "=== 1 failed, 1 error in 0.10s ===",
      NESTED_START,
      "=== FAILURES ===",
      "___ test_inner_two ___",
      "=== 2 failed in 0.20s ===",
      "-------- generated xml file: /files/result.xml --------",
      SUMMARY,
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.boundary]),
    [["test_outer", "complete"]],
  );
  assert.equal(failures[0].extraction?.span.endLine, 15);
});

test("after a nested session closes, the outer region goes on and finds the next outer failure", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_outer ___",
      "----------------- Captured stdout call -----------------",
      NESTED_START,
      "___ test_inner ___",
      "=== 1 failed in 0.10s ===",
      "___ test_next ___",
      "E   boom",
      SUMMARY,
    ),
  );
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["test_outer", "test_next"],
  );
});

test("a nested session cut off before its own closing line leaves the outer block truncated", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_outer ___",
      "----------------- Captured stdout call -----------------",
      NESTED_START,
      "=== FAILURES ===",
      "___ test_inner ___",
      "E   cut off",
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.boundary]),
    [["test_outer", "truncated"]],
  );
});

test("a section-looking line in captured output does not end the region, so the next failure is still found", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   first",
      "----------------- Captured stdout call -----------------",
      "=== deploy step ===",
      "___ test_b ___",
      "E   boom",
      SUMMARY,
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.span]),
    [
      ["test_a", { startLine: 2, endLine: 5 }],
      ["test_b", { startLine: 6, endLine: 7 }],
    ],
  );
  assert.equal(failures[0].extraction?.contextSpans?.[0].text.includes("deploy step"), true);
});

test("inside a block, only a known pytest section title is structural: an unknown title in the traceback stays in the evidence", () => {
  const { failures } = extractFailures(
    log("=== FAILURES ===", "___ test_a ___", "==== diff ====", "E   boom", "=== warnings summary ===", "text after"),
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].extraction?.span, { startLine: 2, endLine: 4 });
  assert.ok(failures[0].rawText.includes("==== diff ===="));
  assert.ok(!failures[0].rawText.includes("text after"));
});

test("known limitation: captured output containing an exact pytest section title still ends the region", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "----------------- Captured stdout call -----------------",
      "=== warnings summary ===",
      "___ test_b ___",
      "E   boom",
      SUMMARY,
    ),
  );
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["test_a"],
  );
  assert.equal(diagnostics.find((x) => x.code === "pytest-header-outside-failure-section")?.line, 5);
});

// pytest prints captured output last in a block, so a block's primary evidence is
// one segment. Checked on all 92 blocks in the 49 real logs: 0 resume after captured
// output. The segment model itself allows several (see evidence-segments.test.ts).
test("a block's context spans run to its end, so a block has one primary segment before them", () => {
  const { failures } = extractFailures(
    log(
      "=== FAILURES ===",
      "___ test_a ___",
      "E   boom",
      "----------------- Captured stderr call -----------------",
      "stderr text",
      "E   looks like a traceback line but is captured output",
      SUMMARY,
    ),
  );
  assert.deepEqual(failures[0].segments, [{ startLine: 2, endLine: 3, text: "___ test_a ___\nE   boom" }]);
  assert.equal(failures[0].extraction?.contextSpans?.[0].endLine, 6);
});

// ---- detection and consistency ----

test("a header with no FAILURES or ERRORS section around it is not read as pytest", () => {
  const failures = parseLog(log("_______________________ test_a _______________________", "E   AssertionError: x"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].framework, "generic");
});

test("extractFailures and parseLog return the same failures", () => {
  const text = readFileSync("fixtures/pytest-sample.log", "utf8");
  assert.deepEqual(parseLog(text), extractFailures(text).failures);
});

// For every log with pytest failures: spans are in order and do not overlap, and the
// text of every segment and context span is exactly the cleaned original lines it names.
const PYTEST_LOGS = [
  "fixtures/pytest-sample.log",
  "fixtures/pytest-grouping-sample.log",
  "fixtures/github-actions-pytest.log",
  ...readdirSync("fixtures/real-excerpts")
    .filter((f) => f.startsWith("pytest-") && f.endsWith(".log"))
    .map((f) => `fixtures/real-excerpts/${f}`),
];

for (const file of PYTEST_LOGS) {
  test(`traceability: ${file} has ordered, non-overlapping spans, and every segment's text is its original lines`, () => {
    const raw = readFileSync(file, "utf8");
    // Split on CRLF too: two of these logs use Windows line endings.
    const originalLines = raw.split(/\r?\n/);
    const textOf = (start: number, end: number) => cleanLog(originalLines.slice(start - 1, end).join("\n"));
    const { failures } = extractFailures(raw);
    let previousEnd = 0;
    for (const f of failures) {
      const span = f.extraction?.span;
      assert.ok(span && span.startLine > previousEnd && span.endLine >= span.startLine, `${f.testName}: span`);
      previousEnd = span.endLine;
      for (const s of f.segments ?? []) {
        assert.ok(s.startLine >= span.startLine && s.endLine <= span.endLine, `${f.testName}: segment inside span`);
        assert.equal(s.text, textOf(s.startLine, s.endLine), `${f.testName}: segment text`);
      }
      for (const c of f.extraction?.contextSpans ?? []) {
        assert.ok(c.startLine >= span.startLine && c.endLine <= span.endLine, `${f.testName}: context inside span`);
        assert.equal(c.text, textOf(c.startLine, c.endLine), `${f.testName}: context text`);
      }
      assert.equal(f.rawText, (f.segments ?? []).map((s) => s.text).join("\n"), `${f.testName}: rawText is derived`);
    }
  });
}

// Review of 6796940, P1: a diagnostic's public message must never contain raw log
// content. sectionTitle comes straight from the log, so it must not be interpolated
// into the message, even though it's useful for a human reading the internal result.
test("a section title containing a secret never reaches the diagnostic's public message", () => {
  const { diagnostics } = extractFailures(
    log("=== Authorization: Bearer SECRET_VALUE ===", "___ test_example ___", "E   AssertionError: expected 1, got 2"),
  );
  const d = diagnostics.find((x) => x.code === "pytest-header-outside-failure-section");
  assert.ok(d, "diagnostic should exist");
  assert.ok(!d!.message.includes("SECRET_VALUE"), `message leaked log content: ${d!.message}`);
  assert.ok(!d!.message.includes("Bearer"), `message leaked log content: ${d!.message}`);
});
