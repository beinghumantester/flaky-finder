import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWithRules } from "../src/rules.js";
import type { Failure } from "../src/types.js";

function failure(rawText: string): Failure {
  return { testName: "sample_test", framework: "generic", rawText };
}

test("network reset is classified LIKELY_FLAKY with high confidence", () => {
  const result = classifyWithRules(failure("E requests.exceptions.ConnectionError: Connection reset by peer"));
  assert.equal(result.verdict, "LIKELY_FLAKY");
  assert.equal(result.confidence, "high");
  assert.equal(result.source, "rule");
});

test("stale element reference is classified LIKELY_FLAKY", () => {
  const result = classifyWithRules(failure("StaleElementReferenceException: stale element reference: element is not attached to the page document"));
  assert.equal(result.verdict, "LIKELY_FLAKY");
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

test("date/time-sensitive failures are UNVERIFIED, not silently upgraded to flaky", () => {
  const result = classifyWithRules(failure("RangeError: Invalid time value at toLocaleDateString"));
  assert.equal(result.verdict, "UNVERIFIED");
});
