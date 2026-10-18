import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWithRules, RULES } from "../src/rules.js";
import type { Failure } from "../src/types.js";

function failure(rawText: string): Failure {
  return { testName: "sample_test", framework: "generic", rawText };
}

test("network reset is classified ENVIRONMENT_SIGNAL_DETECTED with high confidence", () => {
  const result = classifyWithRules(failure("E requests.exceptions.ConnectionError: Connection reset by peer"));
  assert.equal(result.verdict, "ENVIRONMENT_SIGNAL_DETECTED");
  assert.equal(result.confidence, "high");
  assert.equal(result.source, "rule");
});

test("stale element reference is classified ENVIRONMENT_SIGNAL_DETECTED", () => {
  const result = classifyWithRules(failure("StaleElementReferenceException: stale element reference: element is not attached to the page document"));
  assert.equal(result.verdict, "ENVIRONMENT_SIGNAL_DETECTED");
});

test("a plain assertion mismatch with no known signal is UNVERIFIED, never a guess", () => {
  const result = classifyWithRules(failure("AssertionError: expected 200 to equal 180"));
  assert.equal(result.verdict, "UNVERIFIED");
  assert.equal(result.confidence, "none");
  assert.equal(result.source, "none");
});

test("every rule result cites an evidence line taken from the input", () => {
  const raw = "some context\nECONNRESET: socket hang up\nmore context";
  const result = classifyWithRules(failure(raw));
  assert.ok(result.evidenceLine && raw.includes(result.evidenceLine));
});

test("date/time-sensitive failures are UNVERIFIED, not silently upgraded to a signal", () => {
  const result = classifyWithRules(failure("RangeError: Invalid time value at toLocaleDateString"));
  assert.equal(result.verdict, "UNVERIFIED");
});

// --- Adversarial cases: the whole point of this engine is that it must not
// overclaim even when a misleading-but-matching signature is present. ---

test("a timeout caused by a genuine regression still only gets ENVIRONMENT_SIGNAL_DETECTED, never a stronger claim either way", () => {
  // Scenario from review: the button never rendered because of a real product
  // regression, but the test's own error text is indistinguishable from a
  // slow-runner timeout. The engine CANNOT know the difference from this log
  // alone, so it must report the signature honestly without resolving — in
  // either direction — whether it's actually fine or actually broken.
  const raw = [
    "Error: page.waitForSelector: Test timeout of 30000ms exceeded.",
    "waiting for selector '#checkout-confirm-button' to be visible",
    "// root cause (not visible to the tool): button render was removed in this PR",
  ].join("\n");
  const result = classifyWithRules(failure(raw));
  assert.equal(result.verdict, "ENVIRONMENT_SIGNAL_DETECTED");
  assert.match(result.explanation, /NOT proof|not a confirmed diagnosis/i);
});

// One real, matching log line per rule — not derived from the regex source,
// which would be fragile for multi-word alternations (e.g. "stale element
// reference" as a phrase isn't matched by the word "stale" alone).
const RULE_PROBES: Record<string, string> = {
  "network-reset": "ECONNRESET: socket hang up",
  "port-in-use": "Error: listen EADDRINUSE: address already in use :::3000",
  "stale-dom-element": "StaleElementReferenceException: stale element reference: element is not attached to the page document",
  "dns-resolution": "Error: getaddrinfo ENOTFOUND api.example.com",
  "timeout-exceeded": "Error: Test timeout of 30000ms exceeded.",
  "locator-target-closed": "Error: locator.click: Target closed",
  "resource-exhaustion": "Error: EMFILE: too many open files",
  "db-contention": "OperationalError: database is locked",
  "teardown-hang": "Jest did not exit one second after the test run has completed.",
  "unique-constraint-pollution": "IntegrityError: duplicate key value violates unique constraint",
};

test("every ENVIRONMENT_SIGNAL_DETECTED rule's explanation carries the signal-is-not-proof caveat (output contract, checked for every rule, not just the ones in other tests)", () => {
  const signalRules = RULES.filter((r) => r.verdict === "ENVIRONMENT_SIGNAL_DETECTED");
  assert.ok(signalRules.length > 0, "expected at least one ENVIRONMENT_SIGNAL_DETECTED rule to exist");
  for (const rule of signalRules) {
    const probe = RULE_PROBES[rule.id];
    assert.ok(probe, `add a RULE_PROBES["${rule.id}"] entry for this new rule so the contract test covers it`);
    const result = classifyWithRules(failure(probe));
    assert.equal(result.ruleId, rule.id, `probe for "${rule.id}" didn't actually trigger that rule — fix the probe`);
    assert.match(
      result.explanation,
      /NOT proof the test is actually intermittent/i,
      `rule ${rule.id} must carry the signal-is-not-proof caveat`
    );
  }
});

test("the deterministic rule engine never assigns SUSPECTED_REGRESSION — that verdict only exists for the constrained, optional LLM step", () => {
  assert.ok(
    RULES.every((rule) => rule.verdict !== "SUSPECTED_REGRESSION"),
    "a rule engine that only sees ONE run of logs has no basis to positively diagnose a regression"
  );
});
