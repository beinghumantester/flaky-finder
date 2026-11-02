import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLlmContent } from "../src/llm.js";

// These test the actual safety contract of the optional LLM step — that a
// model's own claims can't push past what one run of evidence supports —
// without mocking a network call. A review specifically asked for this: the
// rule engine's own tests don't say anything about whether the LLM step is
// constrained.

test("SUSPECTED_REGRESSION is capped at low confidence even if the model claims medium", () => {
  const result = parseLlmContent(
    JSON.stringify({ verdict: "SUSPECTED_REGRESSION", confidence: "medium", explanation: "looks like a real bug" })
  );
  assert.equal(result.verdict, "SUSPECTED_REGRESSION");
  assert.equal(result.confidence, "low", "a model claiming higher confidence than the contract allows must be overridden, not trusted");
});

test("ENVIRONMENT_SIGNAL_DETECTED may reach medium confidence (not every verdict is capped at low)", () => {
  const result = parseLlmContent(
    JSON.stringify({ verdict: "ENVIRONMENT_SIGNAL_DETECTED", confidence: "medium", explanation: "network-looking error" })
  );
  assert.equal(result.confidence, "medium");
});

test("an unrecognized verdict string falls back to UNVERIFIED, never passed through as-is", () => {
  const result = parseLlmContent(JSON.stringify({ verdict: "DEFINITELY_FLAKY", confidence: "medium", explanation: "sure of it" }));
  assert.equal(result.verdict, "UNVERIFIED");
});

test("a missing verdict field falls back to UNVERIFIED", () => {
  const result = parseLlmContent(JSON.stringify({ confidence: "medium", explanation: "no verdict given" }));
  assert.equal(result.verdict, "UNVERIFIED");
});

test("a missing or non-string explanation gets a safe default instead of crashing or showing undefined", () => {
  const result = parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED" }));
  assert.equal(typeof result.explanation, "string");
  assert.ok(result.explanation.length > 0);
});

test("a confidence value other than exactly 'medium' defaults to low, not passed through unchecked", () => {
  const result = parseLlmContent(
    JSON.stringify({ verdict: "ENVIRONMENT_SIGNAL_DETECTED", confidence: "extremely high", explanation: "x" })
  );
  assert.equal(result.confidence, "low");
});

test("malformed (non-JSON) model output throws, rather than silently producing a fabricated result", () => {
  assert.throws(() => parseLlmContent("I'm quite confident this is flaky, no JSON here"));
});

test("an empty string throws, same as any other invalid JSON — caller's catch block handles it as UNVERIFIED", () => {
  assert.throws(() => parseLlmContent(""));
});
