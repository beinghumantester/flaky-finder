import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomRuleError, parseCustomRules } from "../src/custom-rules.js";
import { classifyWithRules } from "../src/rules.js";
import type { Failure } from "../src/types.js";

function failure(rawText: string): Failure {
  return { testName: "sample_test", framework: "generic", rawText };
}

function rulesJson(...rules: object[]): string {
  return JSON.stringify({ rules });
}

const INTERNAL_HOST_RULE = {
  id: "internal-mirror-down",
  category: "network",
  verdict: "ENVIRONMENT_SIGNAL_DETECTED",
  matchStrength: "exact",
  pattern: "artifacts\\.corp\\.example\\.com.*(503|ECONNRESET)",
  explanation: "The internal artifact mirror was unreachable ({line}).",
};

test("a custom rule matches, cites its evidence line, and is marked as custom", () => {
  const rules = parseCustomRules(rulesJson(INTERNAL_HOST_RULE));
  const result = classifyWithRules(failure("GET https://artifacts.corp.example.com/pkg -> 503"), rules);
  assert.equal(result.verdict, "ENVIRONMENT_SIGNAL_DETECTED");
  assert.equal(result.ruleId, "internal-mirror-down");
  assert.equal(result.ruleOrigin, "custom");
  assert.equal(result.evidenceLine, "GET https://artifacts.corp.example.com/pkg -> 503");
  assert.match(result.explanation, /^The internal artifact mirror was unreachable \(GET https:/);
});

test("a custom rule still gets the uniform 'not a confirmed diagnosis' caveat", () => {
  const rules = parseCustomRules(rulesJson(INTERNAL_HOST_RULE));
  const result = classifyWithRules(failure("artifacts.corp.example.com 503"), rules);
  assert.match(result.explanation, /not a confirmed diagnosis/);
});

test("custom rules take precedence over a built-in rule that also matches", () => {
  const rules = parseCustomRules(rulesJson(INTERNAL_HOST_RULE));
  const result = classifyWithRules(failure("artifacts.corp.example.com: ECONNRESET"), rules);
  assert.equal(result.ruleId, "internal-mirror-down", "built-in network-reset would match too, but custom is first");
});

test("built-in matches are marked builtin", () => {
  assert.equal(classifyWithRules(failure("ECONNRESET")).ruleOrigin, "builtin");
});

test("a custom rule may not claim SUSPECTED_REGRESSION", () => {
  assert.throws(
    () => parseCustomRules(rulesJson({ ...INTERNAL_HOST_RULE, verdict: "SUSPECTED_REGRESSION" }), "team.json"),
    (err: Error) =>
      err instanceof CustomRuleError && /team\.json: rules\[0\]: "verdict" must be one of/.test(err.message),
  );
});

test("stateful regex flags (g, y) are rejected so a rule can't match one failure and miss the next", () => {
  assert.throws(() => parseCustomRules(rulesJson({ ...INTERNAL_HOST_RULE, flags: "gi" })), CustomRuleError);
  assert.throws(() => parseCustomRules(rulesJson({ ...INTERNAL_HOST_RULE, flags: "y" })), CustomRuleError);
});

test("an invalid regex, a duplicate id, or a built-in id collision is a clear error", () => {
  assert.throws(() => parseCustomRules(rulesJson({ ...INTERNAL_HOST_RULE, pattern: "(" })), /not a valid regex/);
  assert.throws(() => parseCustomRules(rulesJson(INTERNAL_HOST_RULE, INTERNAL_HOST_RULE)), /duplicate id/);
  assert.throws(() => parseCustomRules(rulesJson({ ...INTERNAL_HOST_RULE, id: "network-reset" })), /duplicate id/);
});

test("a rule with a missing required field is rejected, naming the field", () => {
  for (const field of ["id", "category", "verdict", "matchStrength", "pattern"]) {
    const rule: Record<string, unknown> = { ...INTERNAL_HOST_RULE };
    delete rule[field];
    assert.throws(
      () => parseCustomRules(rulesJson(rule)),
      (err: Error) => err instanceof CustomRuleError && err.message.includes(`"${field}"`),
      `missing ${field} should be rejected`,
    );
  }
});

test("malformed files fail loudly instead of loading zero rules", () => {
  assert.throws(() => parseCustomRules("{not json"), /not valid JSON/);
  assert.throws(() => parseCustomRules("{}"), /"rules" array/);
  assert.throws(
    () => parseCustomRules(rulesJson({ ...INTERNAL_HOST_RULE, matchStrength: "certain" })),
    /matchStrength/,
  );
});

test("without an explanation, a default one still cites the matched line", () => {
  const noExplanation = { ...INTERNAL_HOST_RULE, explanation: undefined };
  const rules = parseCustomRules(rulesJson(noExplanation));
  const result = classifyWithRules(failure("artifacts.corp.example.com 503"), rules);
  assert.match(
    result.explanation,
    /^Custom rule "internal-mirror-down" matched \(artifacts\.corp\.example\.com 503\)\./,
  );
});
