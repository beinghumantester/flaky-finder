import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { cleanLog } from "../src/log-cleaning.js";
import { extractFailures, parseLog } from "../src/parser.js";

// Step 4: the Jest extractor. Rules come from docs/design/failure-evidence-boundaries.md,
// section "Jest". Small made-up logs test one rule each; the real excerpts are in
// extraction.acceptance.test.ts.

function log(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

const SUITES = "Test Suites: 1 failed, 1 total";

test("each failure gets its own span, and evidence stops at the next bullet", () => {
  const { failures } = extractFailures(
    log(
      "FAIL src/cart.test.js",
      "  ● Cart › retries",
      "",
      "    ECONNRESET: socket hang up",
      "",
      "  ● Cart › applies discount",
      "",
      "    Expected: 90",
      SUITES,
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.framework, f.extraction?.span, f.extraction?.boundary, f.extraction?.method]),
    [
      ["Cart › retries", "jest", { startLine: 2, endLine: 4 }, "complete", "jest-fail-block"],
      ["Cart › applies discount", "jest", { startLine: 6, endLine: 8 }, "complete", "jest-fail-block"],
    ],
  );
  assert.equal(failures[0].rawText, "  ● Cart › retries\n\n    ECONNRESET: socket hang up");
  assert.deepEqual(failures[0].segments, [
    { startLine: 2, endLine: 4, text: "  ● Cart › retries\n\n    ECONNRESET: socket hang up" },
  ]);
});

for (const [marker, text] of [
  ["a later FAIL line", "FAIL src/b.test.js"],
  ["a later PASS line", "PASS src/b.test.js"],
  ["Test Suites:", SUITES],
  ["Summary of all failing tests", "Summary of all failing tests"],
  ["a GitHub Actions ##[ marker", "##[group]Run next step"],
] as const) {
  test(`a block ends at ${marker}, so later text is not attached to the failure`, () => {
    const { failures } = extractFailures(
      log("FAIL src/a.test.js", "  ● A › fails", "    boom", text, "ECONNRESET after the block"),
    );
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].extraction?.span, { startLine: 2, endLine: 3 });
    assert.equal(failures[0].extraction?.boundary, "complete");
    assert.ok(!failures[0].rawText.includes("ECONNRESET"));
  });
}

test("a log that ends inside a block is truncated", () => {
  const { failures } = extractFailures(log("FAIL src/a.test.js", "  ● A › fails", "    cut off"));
  assert.equal(failures[0].extraction?.boundary, "truncated");
});

// ---- indentation: nested output stays inside the outer block ----

test("indented FAIL, PASS, Test Suites: and bullet lines are nested output, not markers", () => {
  const { failures } = extractFailures(
    log(
      "FAIL e2e/outer.test.ts",
      "  ● outer › fails",
      "    FAIL __tests__/inner.test.js",
      "      ● Test suite failed to run",
      "    PASS __tests__/other.test.js",
      "    Test Suites: 2 failed, 2 total",
      "    still the outer failure",
      SUITES,
    ),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.span, f.extraction?.boundary]),
    [["outer › fails", { startLine: 2, endLine: 7 }, "complete"]],
  );
});

test("a bullet indented more than 2 spaces is not a failure header, even under FAIL", () => {
  const { failures } = extractFailures(log("FAIL a.test.js", "    ● Cart › old style", "    boom", SUITES));
  assert.equal(failures.filter((f) => f.framework === "jest").length, 0);
});

// ---- what is not a failure ----

for (const [label, bullet, code] of [
  ["Console", "● Console", "jest-console-block"],
  ["Validation Warning", "● Validation Warning:", "jest-validation-warning-block"],
] as const) {
  for (const indent of ["", "  "]) {
    for (const context of ["FAIL src/a.test.js", "PASS src/a.test.js"]) {
      test(`${label} at indent ${indent.length} under ${context.slice(0, 4)} is not a failure, and its lines go nowhere else`, () => {
        const { failures, diagnostics } = extractFailures(
          log(
            "FAIL src/first.test.js",
            "  ● First › really fails",
            "    real failure text",
            context,
            `${indent}${bullet}`,
            "    console.log ECONNRESET from a console line",
            "",
            "  ● Second › really fails too",
            "    more failure text",
            SUITES,
          ),
        );
        assert.deepEqual(
          failures.map((f) => f.testName),
          context.startsWith("FAIL") ? ["First › really fails", "Second › really fails too"] : ["First › really fails"],
        );
        assert.ok(failures.every((f) => !f.rawText.includes("ECONNRESET")));
        const d = diagnostics.find((x) => x.code === code);
        assert.equal(d?.line, 5);
        assert.equal(d?.text, `${indent}${bullet}`);
      });
    }
  }
}

test("a bullet with no FAIL or summary context creates no failure and is reported with its line", () => {
  const { failures, diagnostics } = extractFailures(
    log("PASS src/a.test.js", "  ● Installing template", "    npm output ECONNRESET", "PASS src/b.test.js"),
  );
  assert.equal(failures.filter((f) => f.framework === "jest").length, 0);
  const d = diagnostics.find((x) => x.code === "jest-bullet-outside-fail-context");
  assert.equal(d?.line, 2);
  assert.equal(d?.text, "  ● Installing template");
});

test("bullets inside 'Summary of all failing tests' are failures, even though no FAIL block precedes them", () => {
  const { failures } = extractFailures(
    log("Summary of all failing tests", " FAIL src/a.test.js", "  ● A › fails", "    boom", SUITES),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.extraction?.method]),
    [["A › fails", "jest-summary-entry"]],
  );
});

test("a PASS line after the summary ends summary mode, so a later bullet is not a failure", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      "Summary of all failing tests",
      " FAIL src/a.test.js",
      "  ● A › fails",
      "    boom",
      "PASS src/b.test.js",
      "  ● B › a bullet under a passing file",
      "    text",
      SUITES,
    ),
  );
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["A › fails"],
  );
  assert.equal(diagnostics.find((d) => d.code === "jest-bullet-outside-fail-context")?.line, 6);
});

// ---- adversarial formats: the expected result is abstention, never a loosened pattern ----

test("FAIL indented 2 spaces is not a marker, so its bullet has no context and is reported, not extracted", () => {
  const { failures, diagnostics } = extractFailures(log("  FAIL src/a.test.js", "  ● A › fails", "    boom", SUITES));
  assert.equal(failures.filter((f) => f.framework === "jest").length, 0);
  assert.equal(diagnostics.find((d) => d.code === "jest-bullet-outside-fail-context")?.line, 2);
});

test("Jest output wrapped by a CI step prefix on every line is not recognized, and nothing is invented", () => {
  const { failures } = extractFailures(
    log("[step] FAIL src/a.test.js", "[step]   ● A › fails", "[step]     boom", "[step] Test Suites: 1 failed"),
  );
  assert.equal(failures.filter((f) => f.framework === "jest").length, 0);
});

test("a bullet whose title wraps onto the next line keeps only the first line as the name", () => {
  const { failures } = extractFailures(
    log(
      "FAIL src/a.test.js",
      "  ● A very long describe block › with a test name that",
      "    continues here",
      "    boom",
      SUITES,
    ),
  );
  assert.equal(failures[0].testName, "A very long describe block › with a test name that");
  assert.ok(failures[0].rawText.includes("continues here"));
});

test("a suite that failed to run is a failure, like any other bullet under FAIL", () => {
  const { failures } = extractFailures(
    log("FAIL src/a.test.js", "  ● Test suite failed to run", "    Cannot find module 'x'", SUITES),
  );
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["Test suite failed to run"],
  );
});

test("after Test Suites: a bullet is not a failure until a new FAIL line", () => {
  const { failures } = extractFailures(
    log("FAIL a.test.js", "  ● A › fails", SUITES, "  ● Late bullet", "    text", "FAIL b.test.js", "  ● B › fails"),
  );
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["A › fails", "B › fails"],
  );
});

// ---- detection and consistency ----

test("a Playwright log with spinner bullets is not read as Jest", () => {
  const failures = parseLog(
    log(
      "       ●  Installing template /__w/app-template",
      "  1) [chromium] › tests/e2e/login.spec.ts:10:5 › user can log in",
      "    Error: Timed out",
      "  1 failed",
    ),
  );
  assert.deepEqual(
    failures.map((f) => f.framework),
    ["playwright"],
  );
});

test("a pytest log is still read as pytest even when it also prints Jest-looking lines", () => {
  const failures = parseLog(
    log("=== FAILURES ===", "___ test_a ___", "FAIL a.test.js", "  ● A › fails", "=== short test summary info ==="),
  );
  assert.deepEqual(
    failures.map((f) => f.framework),
    ["pytest"],
  );
});

test("extractFailures and parseLog return the same failures", () => {
  const text = readFileSync("fixtures/jest-sample.log", "utf8");
  assert.deepEqual(parseLog(text), extractFailures(text).failures);
});

// For every log that yields Jest failures: spans are in order and do not overlap, and
// each segment's text is exactly the cleaned original lines it names.
const JEST_LOGS = [
  "fixtures/jest-sample.log",
  ...readdirSync("fixtures/real-excerpts")
    .filter((f) => f.startsWith("jest-") && f.endsWith(".log"))
    .map((f) => `fixtures/real-excerpts/${f}`),
];

for (const file of JEST_LOGS) {
  test(`traceability: ${file} has ordered, non-overlapping spans, and every segment's text is its original lines`, () => {
    const raw = readFileSync(file, "utf8");
    const originalLines = raw.split(/\r?\n/);
    const textOf = (start: number, end: number) => cleanLog(originalLines.slice(start - 1, end).join("\n"));
    let previousEnd = 0;
    for (const f of extractFailures(raw).failures.filter((x) => x.framework === "jest")) {
      const span = f.extraction?.span;
      assert.ok(span && span.startLine > previousEnd && span.endLine >= span.startLine, `${f.testName}: span`);
      previousEnd = span.endLine;
      for (const s of f.segments ?? []) {
        assert.equal(s.text, textOf(s.startLine, s.endLine), `${f.testName}: segment text`);
      }
      assert.equal(f.rawText, (f.segments ?? []).map((s) => s.text).join("\n"), `${f.testName}: rawText is derived`);
    }
  });
}
