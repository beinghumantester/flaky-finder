import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFailures } from "../src/failure-grouping.js";
import type { AnalysisResult, Confidence, MatchStrength, RuleOrigin, Verdict } from "../src/types.js";

// Minimal, fully-controlled AnalysisResult — lets tests construct exact
// ruleId/ruleOrigin/confidence combinations without going through
// classifyWithRules, including combinations no real rule produces today
// (e.g. a shared id across origins), which is exactly what the
// defensiveness tests below need.
function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    testName: "sample_test",
    framework: "generic",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED" as Verdict,
    confidence: "exact" as MatchStrength | Confidence,
    category: "network",
    ruleId: "network-reset",
    ruleOrigin: "builtin" as RuleOrigin,
    evidenceLine: "ECONNRESET",
    explanation: "...",
    source: "rule",
    ...overrides,
  };
}

test("1. exact and strong rules are grouped by default", () => {
  const exact = groupFailures([
    result({ testName: "a", confidence: "exact" }),
    result({ testName: "b", confidence: "exact" }),
  ]);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].occurrenceCount, 2);

  const strong = groupFailures([
    result({ testName: "a", ruleId: "timeout-exceeded", confidence: "strong" }),
    result({ testName: "b", ruleId: "timeout-exceeded", confidence: "strong" }),
  ]);
  assert.equal(strong.length, 1);
  assert.equal(strong[0].matchStrength, "strong");
});

test("2. weak rules are excluded by default", () => {
  const groups = groupFailures([
    result({ testName: "a", ruleId: "teardown-hang", confidence: "weak" }),
    result({ testName: "b", ruleId: "teardown-hang", confidence: "weak" }),
  ]);
  assert.deepEqual(groups, []);
});

test("3. weak rules are included when the flag is supplied", () => {
  const groups = groupFailures(
    [
      result({ testName: "a", ruleId: "teardown-hang", confidence: "weak" }),
      result({ testName: "b", ruleId: "teardown-hang", confidence: "weak" }),
    ],
    { includeWeak: true },
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matchStrength, "weak");
});

test("4. custom rules expose ruleOrigin: 'custom'", () => {
  const groups = groupFailures([
    result({ testName: "a", ruleId: "internal-mirror-down", ruleOrigin: "custom" }),
    result({ testName: "b", ruleId: "internal-mirror-down", ruleOrigin: "custom" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ruleOrigin, "custom");
});

test("5. a custom rule and a built-in rule sharing the same id string do not silently merge", () => {
  // custom-rules.ts rejects this at load time in practice; this test proves
  // the grouping function doesn't rely on that upstream check to stay correct.
  const groups = groupFailures([
    result({ testName: "a", ruleId: "network-reset", ruleOrigin: "builtin" }),
    result({ testName: "b", ruleId: "network-reset", ruleOrigin: "builtin" }),
    result({ testName: "c", ruleId: "network-reset", ruleOrigin: "custom" }),
    result({ testName: "d", ruleId: "network-reset", ruleOrigin: "custom" }),
  ]);
  assert.equal(groups.length, 2, "two distinct groups, not one merged group of 4");
  for (const g of groups) assert.equal(g.occurrenceCount, 2);
});

test("6. grouping does not mutate the original analysis results", () => {
  const results = [result({ testName: "a" }), result({ testName: "b" })];
  // Object.freeze makes any accidental write throw in strict mode (ESM
  // modules are strict by default), turning silent mutation into a failing
  // test instead of a passing one that happened not to notice.
  const frozen = results.map((r) => Object.freeze({ ...r }));
  const before = JSON.stringify(frozen);
  const groups = groupFailures(frozen);
  assert.equal(JSON.stringify(frozen), before);
  assert.deepEqual(groups[0].observations, frozen);
});

test("7. group counts reflect failure observations, including duplicate observations from the same test", () => {
  // Simulates a retried test that failed twice under the same rule — same
  // testName, two separate observations (see junit-parser.ts's documented
  // handling of duplicate <testcase> entries from a retry plugin).
  const groups = groupFailures([
    result({ testName: "test_fetch_user_retries" }),
    result({ testName: "test_fetch_user_retries" }),
    result({ testName: "test_other" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrenceCount, 3, "three observations");
  assert.equal(groups[0].affectedTestCount, 2, "only two distinct test identities");
  assert.deepEqual(groups[0].affectedTestIds.sort(), ["test_fetch_user_retries", "test_other"]);
});

test("a rule that matched only once is not reported as a group", () => {
  assert.deepEqual(groupFailures([result({ testName: "a" })]), []);
});

test("llm and unverified-from-no-match results are never grouped", () => {
  const groups = groupFailures([
    {
      testName: "a",
      framework: "generic",
      verdict: "UNVERIFIED",
      confidence: "low",
      explanation: "...",
      source: "llm",
    },
    {
      testName: "b",
      framework: "generic",
      verdict: "UNVERIFIED",
      confidence: "none",
      explanation: "...",
      source: "none",
    },
    {
      testName: "c",
      framework: "generic",
      verdict: "UNVERIFIED",
      confidence: "low",
      explanation: "...",
      source: "llm",
    },
  ]);
  assert.deepEqual(groups, []);
});

test("groups are sorted largest first, then by ruleId", () => {
  const groups = groupFailures([
    result({ testName: "a", ruleId: "db-contention", category: "concurrency" }),
    result({ testName: "b", ruleId: "db-contention", category: "concurrency" }),
    result({ testName: "c", ruleId: "network-reset" }),
    result({ testName: "d", ruleId: "network-reset" }),
    result({ testName: "e", ruleId: "network-reset" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.ruleId),
    ["network-reset", "db-contention"],
  );
});

test("every group states the same fixed limitation", () => {
  const groups = groupFailures([result({ testName: "a" }), result({ testName: "b" })]);
  assert.match(groups[0].limitation, /not a confirmed shared root cause/);
});

test("empty input produces no groups", () => {
  assert.deepEqual(groupFailures([]), []);
});
