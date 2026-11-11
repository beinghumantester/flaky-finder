import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFailure, collectLogSignals, isEligible, ABSTAIN_EXPLANATIONS } from "../src/analysis.js";
import { extractFailures } from "../src/parser.js";
import type { LlmOutcome } from "../src/llm.js";
import type { BoundaryState, EvidenceSegment, Failure, Rule } from "../src/types.js";

// The final outcome table from docs/design/failure-evidence-boundaries.md, row by
// row, with a stubbed LLM. Eligibility is checked before any classifier runs, rules
// match one segment at a time, and every reason comes from exactly one stage.

function observation(
  segments: EvidenceSegment[],
  boundary: BoundaryState = "complete",
  context: { startLine: number; endLine: number; text: string }[] = [],
): Failure {
  const first = segments[0]?.startLine ?? 1;
  const last = Math.max(segments.at(-1)?.endLine ?? 1, context.at(-1)?.endLine ?? 1);
  return {
    testName: "test_x",
    framework: "pytest",
    rawText: segments.map((s) => s.text).join("\n"),
    segments,
    extraction: {
      method: "pytest-failures-section",
      boundary,
      span: { startLine: first, endLine: last },
      phase: "call",
      ...(context.length ? { contextSpans: context } : {}),
    },
  };
}

const RESET: EvidenceSegment = { startLine: 3, endLine: 3, text: "E   ConnectionResetError: Connection reset by peer" };
const PLAIN: EvidenceSegment = { startLine: 3, endLine: 3, text: "E   AssertionError: 1 == 2" };

function stubLlm(outcome: LlmOutcome) {
  const calls: Failure[] = [];
  const llm = async (f: Failure) => {
    calls.push(f);
    return outcome;
  };
  return { llm, calls };
}

// ---- eligibility ----

test("eligibility: complete with evidence is eligible; truncated, unknown, and complete-but-empty are not; text with no extraction is", () => {
  assert.equal(isEligible(observation([RESET])), true);
  assert.equal(isEligible(observation([RESET], "truncated")), false);
  assert.equal(isEligible(observation([RESET], "unknown")), false);
  assert.equal(isEligible(observation([], "complete")), false);
  assert.equal(isEligible({ testName: "t", framework: "generic", rawText: "ECONNRESET" }), true);
});

for (const [boundary, reason] of [
  ["truncated", "boundary-truncated"],
  ["unknown", "boundary-unknown"],
] as const) {
  test(`a ${boundary} block with a signature in it is UNVERIFIED with ${reason}, lists the signal, and never reaches the LLM`, async () => {
    const { llm, calls } = stubLlm({
      kind: "verdict",
      verdict: "ENVIRONMENT_SIGNAL_DETECTED",
      confidence: "medium",
      explanation: "x",
    });
    const result = await analyzeFailure(observation([RESET], boundary), [], llm);
    assert.equal(result.verdict, "UNVERIFIED");
    assert.equal(result.abstainReason, reason);
    assert.equal(result.source, "none");
    assert.equal(result.explanation, ABSTAIN_EXPLANATIONS[reason]);
    assert.deepEqual(
      result.unattributedSignals?.map((u) => [u.ruleId, u.line, u.where]),
      [["network-reset", 3, "ineligible-block"]],
    );
    assert.equal(calls.length, 0);
    assert.equal(result.extraction?.boundary, boundary);
  });
}

// ---- rules on segments ----

test("a rule match in primary evidence gives the rule's verdict and the evidence's original line", async () => {
  const result = await analyzeFailure(observation([{ startLine: 10, endLine: 12, text: "a\nb\nE   ECONNRESET here" }]));
  assert.equal(result.verdict, "ENVIRONMENT_SIGNAL_DETECTED");
  assert.equal(result.ruleId, "network-reset");
  assert.deepEqual(result.evidenceLocation, { startLine: 12, endLine: 12 });
  assert.equal(result.evidenceLine, "E   ECONNRESET here");
});

test("a match after a removed captured-output gap reports its true original line, not an offset from the block start", async () => {
  const result = await analyzeFailure(
    observation(
      [
        { startLine: 100, endLine: 101, text: "___ test_x ___\nE   assert False" },
        { startLine: 141, endLine: 142, text: "more\nsocket hang up" },
      ],
      "complete",
      [{ startLine: 102, endLine: 140, text: "captured" }],
    ),
  );
  assert.deepEqual(result.evidenceLocation, { startLine: 142, endLine: 142 });
});

test("a pattern that would match only across two segments is not reported: that text never appeared together", async () => {
  const crossGap: Rule = {
    id: "cross-gap",
    category: "test",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "exact",
    pattern: /first part\s+second part/,
    explain: () => "x",
    origin: "custom",
  };
  const f = observation([
    { startLine: 1, endLine: 1, text: "first part" },
    { startLine: 5, endLine: 5, text: "second part" },
  ]);
  assert.match(f.rawText, crossGap.pattern, "the joined rawText would match, which is exactly the trap");
  const result = await analyzeFailure(f, [crossGap]);
  assert.equal(result.source, "none");
  assert.equal(result.abstainReason, "no-rule-matched");
});

test("a rule whose own verdict is UNVERIFIED gives rule-abstained, and the LLM does not run", async () => {
  const { llm, calls } = stubLlm({
    kind: "verdict",
    verdict: "SUSPECTED_REGRESSION",
    confidence: "low",
    explanation: "x",
  });
  const result = await analyzeFailure(
    observation([{ startLine: 1, endLine: 1, text: "RangeError: Invalid time value" }]),
    [],
    llm,
  );
  assert.equal(result.verdict, "UNVERIFIED");
  assert.equal(result.source, "rule");
  assert.equal(result.abstainReason, "rule-abstained");
  assert.equal(calls.length, 0);
});

test("no rule matched, LLM off: no-rule-matched", async () => {
  const result = await analyzeFailure(observation([PLAIN]));
  assert.equal(result.abstainReason, "no-rule-matched");
  assert.deepEqual(result.unattributedSignals, []);
});

// ---- context ----

test("a signature only in captured output: context-only-signal, listed as a context signal, LLM off", async () => {
  const result = await analyzeFailure(
    observation([PLAIN], "complete", [{ startLine: 5, endLine: 5, text: "ECONNRESET" }]),
  );
  assert.equal(result.verdict, "UNVERIFIED");
  assert.equal(result.abstainReason, "context-only-signal");
  assert.deepEqual(
    result.unattributedSignals?.map((u) => [u.ruleId, u.line, u.where]),
    [["network-reset", 5, "context"]],
  );
});

test("a signature in captured output next to a primary match is listed beside the verdict, and does not change it", async () => {
  const result = await analyzeFailure(
    observation([RESET], "complete", [{ startLine: 5, endLine: 5, text: "EADDRINUSE" }]),
  );
  assert.equal(result.ruleId, "network-reset");
  assert.deepEqual(
    result.unattributedSignals?.map((u) => u.ruleId),
    ["port-in-use"],
  );
});

test("with the LLM on, a context-only signal still goes to the LLM, whose outcome then sets the reason", async () => {
  const { llm, calls } = stubLlm({
    kind: "verdict",
    verdict: "UNVERIFIED",
    confidence: "low",
    explanation: "model abstains",
  });
  const result = await analyzeFailure(
    observation([PLAIN], "complete", [{ startLine: 5, endLine: 5, text: "ECONNRESET" }]),
    [],
    llm,
  );
  assert.equal(calls.length, 1);
  assert.equal(result.abstainReason, "insufficient-evidence");
  assert.equal(result.unattributedSignals?.length, 1, "the context signal stays listed");
});

// ---- LLM outcomes ----

for (const [outcome, reason] of [
  [{ kind: "unavailable", detail: "connect ECONNREFUSED http://127.0.0.1:1/x?token=abc" }, "llm-unavailable"],
  [{ kind: "invalid-response", detail: "not JSON" }, "llm-invalid-response"],
  [{ kind: "response-rejected", detail: "confidence is not a string" }, "llm-response-rejected"],
] as const) {
  test(`LLM outcome ${outcome.kind}: UNVERIFIED with ${reason}, and the detail never reaches the explanation`, async () => {
    const { llm } = stubLlm(outcome);
    const result = await analyzeFailure(observation([PLAIN]), [], llm);
    assert.equal(result.verdict, "UNVERIFIED");
    assert.equal(result.abstainReason, reason);
    assert.equal(result.source, "none");
    assert.equal(result.explanation, ABSTAIN_EXPLANATIONS[reason]);
    assert.ok(!result.explanation.includes("127.0.0.1") && !result.explanation.includes("token"));
  });
}

test("a valid UNVERIFIED from the model is insufficient-evidence with the model's own explanation", async () => {
  const { llm } = stubLlm({ kind: "verdict", verdict: "UNVERIFIED", confidence: "low", explanation: "cannot tell" });
  const result = await analyzeFailure(observation([PLAIN]), [], llm);
  assert.equal(result.abstainReason, "insufficient-evidence");
  assert.equal(result.source, "llm");
  assert.equal(result.explanation, "cannot tell");
});

test("a valid verdict from the model is the result, with no abstain reason", async () => {
  const { llm } = stubLlm({
    kind: "verdict",
    verdict: "SUSPECTED_REGRESSION",
    confidence: "low",
    explanation: "logic",
  });
  const result = await analyzeFailure(observation([PLAIN]), [], llm);
  assert.equal(result.verdict, "SUSPECTED_REGRESSION");
  assert.equal(result.source, "llm");
  assert.equal(result.abstainReason, undefined);
});

// ---- text with no extraction ----

test("text with no extraction is classified from rawText as before, and gets no extraction fields", async () => {
  const result = await analyzeFailure({ testName: "t", framework: "generic", rawText: "...\nECONNRESET" });
  assert.equal(result.ruleId, "network-reset");
  assert.equal(result.extraction, undefined);
  assert.equal(result.segments, undefined);
  assert.equal(result.unattributedSignals, undefined);
  assert.equal(result.evidenceLocation, undefined);
});

// ---- top-level signals ----

test("log signals: one entry per rule, counting matches in context, in ineligible blocks, and outside every failure, with the first line", async () => {
  const text = [
    "setup: read ECONNRESET", // outside: 1
    "=== FAILURES ===",
    "___ test_a ___",
    "E   AssertionError",
    "--- Captured stdout call ---",
    "ECONNRESET in context", // context: 2
    "=== short test summary info ===",
    "teardown: socket hang up", // outside: 3
    "postgres: ECONNRESET again", // outside: 4
  ].join("\n");
  const { failures } = extractFailures(text);
  const results = [await analyzeFailure(failures[0])];
  const signals = collectLogSignals(text.split("\n"), failures, results, []);
  assert.deepEqual(
    signals.map((s) => [s.ruleId, s.count, s.firstLine]),
    [["network-reset", 4, 1]],
  );
  assert.equal(signals[0].firstEvidenceLine, "setup: read ECONNRESET");
});

test("an LLM verdict's evidence quote and original location carry through to the AnalysisResult, like a rule match's do", async () => {
  const { llm } = stubLlm({
    kind: "verdict",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "medium",
    explanation: "a network signature",
    evidence: "E   AssertionError: 1 == 2",
    evidenceLocation: { startLine: 3, endLine: 3 },
  });
  const result = await analyzeFailure(observation([PLAIN]), [], llm);
  assert.equal(result.evidenceLine, "E   AssertionError: 1 == 2");
  assert.deepEqual(result.evidenceLocation, { startLine: 3, endLine: 3 });
});
