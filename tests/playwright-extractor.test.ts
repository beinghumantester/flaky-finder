import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { cleanLog } from "../src/log-cleaning.js";
import { extractFailures, parseLog } from "../src/parser.js";

// Step 5: the Playwright extractor. Rules come from docs/design/failure-evidence-boundaries.md,
// section "Playwright". Small made-up logs test one rule each; the real excerpts are in
// extraction.acceptance.test.ts.

function log(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

const ITEM_1 = "  1) [chromium] › login.spec.ts:10:5 › user can log in";
const ITEM_2 = "  2) [chromium] › checkout.spec.ts:22:5 › shows correct total";

test("each item gets its own span, and evidence stops at the next item", () => {
  const { failures } = extractFailures(
    log(ITEM_1, "", "    Error: Target closed", "", ITEM_2, "", "    Expected: 180", "  2 failed"),
  );
  assert.deepEqual(
    failures.map((f) => [f.testName, f.framework, f.extraction?.span, f.extraction?.boundary, f.extraction?.method]),
    [
      [
        "[chromium] › login.spec.ts:10:5 › user can log in",
        "playwright",
        { startLine: 1, endLine: 3 },
        "complete",
        "playwright-failure-item",
      ],
      [
        "[chromium] › checkout.spec.ts:22:5 › shows correct total",
        "playwright",
        { startLine: 5, endLine: 7 },
        "complete",
        "playwright-failure-item",
      ],
    ],
  );
  assert.equal(failures[0].rawText, `${ITEM_1}\n\n    Error: Target closed`);
  assert.deepEqual(failures[0].segments, [{ startLine: 1, endLine: 3, text: `${ITEM_1}\n\n    Error: Target closed` }]);
});

for (const [marker, text] of [
  ["a count line", "  1 failed"],
  ["a flaky count line", "  3 flaky"],
  ["a passed count line with a duration", "  44 passed (12.2m)"],
  ["a GitHub Actions ##[ marker", "##[error]Process completed with exit code 1."],
] as const) {
  test(`the last item ends at ${marker}, so later text is not attached to it`, () => {
    const { failures } = extractFailures(log(ITEM_1, "    Error: boom", text, "read ECONNRESET after the report"));
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].extraction?.span, { startLine: 1, endLine: 2 });
    assert.equal(failures[0].extraction?.boundary, "complete");
    assert.ok(!failures[0].rawText.includes("ECONNRESET"));
  });
}

test("a log that ends inside an item is truncated", () => {
  const { failures } = extractFailures(log(ITEM_1, "    Error: cut off"));
  assert.equal(failures[0].extraction?.boundary, "truncated");
});

// ---- what is not an item ----

test("a shell line such as `124) echo` is not an item, and is reported with its line", () => {
  const { failures, diagnostics } = extractFailures(
    log(
      '    124) echo "::error::pnpm install timed out (exit 124)" ;;',
      '    137) echo "::error::received SIGKILL" ;;',
      ITEM_1,
      "    Error: boom",
      "  1 failed",
    ),
  );
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["[chromium] › login.spec.ts:10:5 › user can log in"],
  );
  assert.deepEqual(
    diagnostics.filter((d) => d.code === "playwright-item-rejected").map((d) => [d.line, d.text]),
    [
      [1, '    124) echo "::error::pnpm install timed out (exit 124)" ;;'],
      [2, '    137) echo "::error::received SIGKILL" ;;'],
    ],
  );
});

test("a numbered line with a bullet but no file:line:col location is not an item", () => {
  const { failures, diagnostics } = extractFailures(
    log("  1) [chromium] › something went wrong with no location", "    Error: boom", "  1 failed"),
  );
  assert.equal(failures.filter((f) => f.framework === "playwright").length, 0);
  assert.equal(diagnostics.find((d) => d.code === "playwright-item-rejected")?.line, 1);
});

test("a numbered line inside an item's text is reported but does not split the item", () => {
  const { failures, diagnostics } = extractFailures(
    log(ITEM_1, "    Steps to fix:", "    1) restart the server", "    2) retry", "  1 failed"),
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].extraction?.span, { startLine: 1, endLine: 4 });
  assert.deepEqual(
    diagnostics.map((d) => d.line),
    [3, 4],
  );
});

// ---- retries ----

test("Retry lines stay inside one observation and each starts a new span in attempts", () => {
  const { failures } = extractFailures(
    log(
      ITEM_1,
      "    Error: first attempt",
      "",
      "    Retry #1 ────────────────────",
      "    Error: second attempt",
      "",
      "    Retry #2 ────────────────────",
      "    Error: third attempt",
      "",
      ITEM_2,
      "    Error: boom",
      "  2 failed",
    ),
  );
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0].extraction?.attempts, [
    { startLine: 1, endLine: 2 },
    { startLine: 4, endLine: 5 },
    { startLine: 7, endLine: 8 },
  ]);
  assert.deepEqual(failures[0].extraction?.span, { startLine: 1, endLine: 8 });
  assert.equal(failures[0].segments?.length, 1);
  assert.ok(failures[0].rawText.includes("third attempt"));
  assert.equal(failures[1].extraction?.attempts, undefined);
});

test("a Retry line as the last line of a truncated log gives a one-line attempt and a truncated item", () => {
  const { failures } = extractFailures(log(ITEM_1, "    Error: first", "    Retry #1 ──────"));
  assert.equal(failures[0].extraction?.boundary, "truncated");
  assert.deepEqual(failures[0].extraction?.attempts, [
    { startLine: 1, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
});

test("retry markers with empty bodies give one-line attempts, in order", () => {
  const { failures } = extractFailures(
    log(ITEM_1, "    Retry #1 ──", "    Retry #2 ──", "    Error: boom", "  1 failed"),
  );
  assert.deepEqual(failures[0].extraction?.attempts, [
    { startLine: 1, endLine: 1 },
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 4 },
  ]);
});

test("a Retry line before any item, or a malformed one inside an item, starts no attempt", () => {
  const { failures } = extractFailures(
    log("    Retry #1 ── stray", ITEM_1, "    Retry # (no number)", "    Error: boom", "  1 failed"),
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].extraction?.attempts, undefined);
  assert.deepEqual(failures[0].extraction?.span, { startLine: 2, endLine: 4 });
});

test("every attempt span starts on its marker line and covers the evidence up to the next marker", () => {
  const { failures } = extractFailures(
    log(ITEM_1, "    Error: a", "", "    Retry #1 ──", "    Error: b", "    at x.ts:1:1", "", "  1 failed"),
  );
  const attempts = failures[0].extraction?.attempts ?? [];
  assert.deepEqual(attempts, [
    { startLine: 1, endLine: 2 },
    { startLine: 4, endLine: 6 },
  ]);
  const lines = failures[0].rawText.split("\n");
  assert.match(lines[attempts[1].startLine - 1], /Retry #1/);
});

// ---- adversarial formats: the expected result is abstention, never a loosened pattern ----

test("an item whose location was stripped by a wrapper is rejected and reported, not extracted", () => {
  const { failures, diagnostics } = extractFailures(
    log("  1) [chromium] › user can log in", "    Error: Timed out", "  1 failed"),
  );
  assert.equal(failures.filter((f) => f.framework === "playwright").length, 0);
  assert.equal(diagnostics.find((d) => d.code === "playwright-item-rejected")?.line, 1);
});

test("an item at unusual indentation is still an item, and its title wraps to the first line only", () => {
  const { failures } = extractFailures(
    log(
      "      1) [chromium] › a.spec.ts:1:1 › a long title that",
      "         continues here",
      "    Error: boom",
      "  1 failed",
    ),
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].testName, "[chromium] › a.spec.ts:1:1 › a long title that");
  assert.ok(failures[0].rawText.includes("continues here"));
});

// ---- detection and consistency ----

// The Jest block has no end marker, so it is truncated and runs to the end; the item
// starts inside it, so the merge step treats the item as the Jest failure's output.
test("a Playwright item inside a truncated Jest block is nested in it, not a second failure", () => {
  const failures = parseLog(log("FAIL a.test.js", "  ● A › fails", "    boom", ITEM_1, "  1 failed"));
  assert.deepEqual(
    failures.map((f) => f.framework),
    ["jest"],
  );
});

test("extractFailures and parseLog return the same failures", () => {
  const text = readFileSync("fixtures/playwright-sample.log", "utf8");
  assert.deepEqual(parseLog(text), extractFailures(text).failures);
});

// For every log that yields Playwright failures: spans are in order and do not overlap,
// attempts sit inside their span, and each segment's text is exactly the cleaned
// original lines it names.
const PLAYWRIGHT_LOGS = [
  "fixtures/playwright-sample.log",
  ...readdirSync("fixtures/real-excerpts")
    // The load failure has no numbered item at all, so there is nothing to trace. It is
    // the known gap the unknown handling in step 6 covers.
    .filter((f) => f.startsWith("playwright-") && f.endsWith(".log") && f !== "playwright-load-failure.log")
    .map((f) => `fixtures/real-excerpts/${f}`),
];

for (const file of PLAYWRIGHT_LOGS) {
  test(`traceability: ${file} has ordered, non-overlapping spans, and every segment's text is its original lines`, () => {
    const raw = readFileSync(file, "utf8");
    const originalLines = raw.split(/\r?\n/);
    const textOf = (start: number, end: number) => cleanLog(originalLines.slice(start - 1, end).join("\n"));
    let previousEnd = 0;
    const found = extractFailures(raw).failures.filter((x) => x.framework === "playwright");
    assert.ok(found.length > 0, "the log should contain Playwright failures, or this test checks nothing");
    for (const f of found) {
      const span = f.extraction?.span;
      assert.ok(span && span.startLine > previousEnd && span.endLine >= span.startLine, `${f.testName}: span`);
      previousEnd = span.endLine;
      let previousAttemptEnd = span.startLine - 1;
      for (const a of f.extraction?.attempts ?? []) {
        assert.ok(a.startLine > previousAttemptEnd && a.endLine <= span.endLine, `${f.testName}: attempt inside span`);
        previousAttemptEnd = a.endLine;
      }
      for (const s of f.segments ?? []) {
        assert.equal(s.text, textOf(s.startLine, s.endLine), `${f.testName}: segment text`);
      }
      assert.equal(f.rawText, (f.segments ?? []).map((s) => s.text).join("\n"), `${f.testName}: rawText is derived`);
    }
  });
}
