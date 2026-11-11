import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLlmUserContent, EVIDENCE_CHAR_LIMIT, parseLlmContent, queryLlm, type LlmFetch } from "../src/llm.js";
import type { Failure } from "../src/types.js";

// The safety contract of the optional LLM step, tested without a network: a model's
// own claims can never push past what one run of evidence supports, every reply
// becomes exactly one outcome kind, and the request carries primary evidence only.

// ---- parseLlmContent: reply -> outcome ----

test("SUSPECTED_REGRESSION is capped at low confidence even if the model claims medium", () => {
  const out = parseLlmContent(
    JSON.stringify({ verdict: "SUSPECTED_REGRESSION", confidence: "medium", explanation: "x", evidence: "boom" }),
  );
  assert.deepEqual(out, {
    kind: "verdict",
    verdict: "SUSPECTED_REGRESSION",
    confidence: "low",
    explanation: "x",
    evidence: "boom",
  });
});

test("ENVIRONMENT_SIGNAL_DETECTED may reach medium confidence (not every verdict is capped at low)", () => {
  const out = parseLlmContent(
    JSON.stringify({
      verdict: "ENVIRONMENT_SIGNAL_DETECTED",
      confidence: "medium",
      explanation: "x",
      evidence: "boom",
    }),
  );
  assert.equal(out.kind, "verdict");
  assert.equal(out.kind === "verdict" && out.confidence, "medium");
});

// Review of 6796940, P1: the model's explanation was never checked against the
// supplied evidence, so a fluent but fabricated explanation was accepted as-is.
// An affirmative verdict (one that claims a cause) must now come with a verbatim
// quote, which queryLlm verifies actually appears in what was sent (below).
// UNVERIFIED makes no causal claim, so no quote is required for it.
test("ENVIRONMENT_SIGNAL_DETECTED or SUSPECTED_REGRESSION with no evidence quote is rejected", () => {
  for (const verdict of ["ENVIRONMENT_SIGNAL_DETECTED", "SUSPECTED_REGRESSION"]) {
    assert.equal(
      parseLlmContent(JSON.stringify({ verdict, confidence: "low", explanation: "x" })).kind,
      "response-rejected",
    );
    assert.equal(
      parseLlmContent(JSON.stringify({ verdict, confidence: "low", explanation: "x", evidence: "" })).kind,
      "response-rejected",
    );
    assert.equal(
      parseLlmContent(JSON.stringify({ verdict, confidence: "low", explanation: "x", evidence: "   " })).kind,
      "response-rejected",
    );
    assert.equal(
      parseLlmContent(JSON.stringify({ verdict, confidence: "low", explanation: "x", evidence: 42 })).kind,
      "response-rejected",
    );
  }
});

test("UNVERIFIED needs no evidence quote: present or absent, it is accepted either way", () => {
  assert.equal(parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED", explanation: "x" })).kind, "verdict");
  const withQuote = parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED", explanation: "x", evidence: "boom" }));
  assert.equal(withQuote.kind, "verdict");
  assert.equal(withQuote.kind === "verdict" && withQuote.evidence, "boom");
});

test("a valid UNVERIFIED reply is a verdict outcome: the model read the evidence and abstained", () => {
  const out = parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED", confidence: "low", explanation: "not enough" }));
  assert.deepEqual(out, { kind: "verdict", verdict: "UNVERIFIED", confidence: "low", explanation: "not enough" });
});

test("an unrecognized verdict string is an invalid response, never passed through and never treated as an answer", () => {
  const out = parseLlmContent(JSON.stringify({ verdict: "DEFINITELY_FLAKY", confidence: "medium", explanation: "x" }));
  assert.equal(out.kind, "invalid-response");
});

test("a missing verdict field is an invalid response", () => {
  assert.equal(parseLlmContent(JSON.stringify({ confidence: "low", explanation: "x" })).kind, "invalid-response");
});

test("a missing explanation gets a safe default; a non-string one is rejected", () => {
  const missing = parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED" }));
  assert.equal(missing.kind === "verdict" && missing.explanation, "LLM gave no explanation.");
  assert.equal(parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED", explanation: 42 })).kind, "response-rejected");
});

test("a confidence string other than exactly 'medium' becomes low; a non-string confidence is rejected", () => {
  const high = parseLlmContent(
    JSON.stringify({ verdict: "ENVIRONMENT_SIGNAL_DETECTED", confidence: "high", explanation: "x", evidence: "boom" }),
  );
  assert.equal(high.kind === "verdict" && high.confidence, "low");
  assert.equal(parseLlmContent(JSON.stringify({ verdict: "UNVERIFIED", confidence: 0.9 })).kind, "response-rejected");
});

test("malformed (non-JSON) output, an empty reply, and a JSON scalar are each an invalid response, never a fabricated verdict", () => {
  assert.equal(parseLlmContent("Sure! The verdict is UNVERIFIED.").kind, "invalid-response");
  assert.equal(parseLlmContent("").kind, "invalid-response");
  assert.equal(parseLlmContent("   ").kind, "invalid-response");
  assert.equal(parseLlmContent('"UNVERIFIED"').kind, "invalid-response");
});

// ---- buildLlmUserContent: what is sent ----

function failure(segments: { startLine: number; endLine: number; text: string }[], context?: string): Failure {
  return {
    testName: "test_x",
    framework: "pytest",
    rawText: segments.map((s) => s.text).join("\n"),
    segments,
    extraction: {
      method: "pytest-failures-section",
      boundary: "complete",
      span: { startLine: segments[0].startLine, endLine: segments.at(-1)!.endLine },
      phase: "call",
      ...(context ? { contextSpans: [{ startLine: 5, endLine: 6, text: context }] } : {}),
    },
  };
}

test("each segment is its own numbered block, and a gap between segments is marked, so joined text is never presented as continuous", () => {
  const { content } = buildLlmUserContent(
    failure([
      { startLine: 2, endLine: 3, text: "line two\nline three" },
      { startLine: 8, endLine: 8, text: "line eight" },
    ]),
  );
  assert.match(content, /\[lines 2-3\]\nline two\nline three/);
  assert.match(content, /\[lines 4-7 left out: captured output, not evidence\]/);
  assert.match(content, /\[lines 8-8\]\nline eight/);
});

test("context is never in the content, even when it is the only place a signature appears", () => {
  const { content } = buildLlmUserContent(
    failure([{ startLine: 2, endLine: 3, text: "E   AssertionError" }], "ConnectionResetError: SECRET_IN_CONTEXT"),
  );
  assert.ok(!content.includes("SECRET_IN_CONTEXT"));
  assert.ok(!content.includes("ConnectionResetError"));
});

test(`at most ${EVIDENCE_CHAR_LIMIT} characters of evidence are sent, and a cut is stated`, () => {
  const big = "x".repeat(EVIDENCE_CHAR_LIMIT + 500);
  const { content, evidenceChars, cut } = buildLlmUserContent(failure([{ startLine: 1, endLine: 1, text: big }]));
  assert.equal(evidenceChars, EVIDENCE_CHAR_LIMIT);
  assert.equal(cut, true);
  assert.match(content, /\[evidence cut at 4000 characters\]/);
  assert.ok(!content.includes("x".repeat(EVIDENCE_CHAR_LIMIT + 1)));
});

test("text with no segments is sent as a single evidence block, as before", () => {
  const { content, cut } = buildLlmUserContent({ testName: "t", framework: "generic", rawText: "boom" });
  assert.match(content, /\[evidence\]\nboom/);
  assert.equal(cut, false);
});

// ---- queryLlm: provider interaction, with a stubbed fetch ----

function stub(reply: () => Promise<{ ok: boolean; status: number; body: unknown; text?: string }>) {
  const calls: { url: string; init: Parameters<LlmFetch>[1] }[] = [];
  const fetchImpl: LlmFetch = async (url, init) => {
    calls.push({ url, init });
    const r = await reply();
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => r.text ?? "" };
  };
  return { fetchImpl, calls };
}

const ok = (content: unknown) => async () => ({ ok: true, status: 200, body: { choices: [{ message: { content } }] } });
const f = failure([{ startLine: 1, endLine: 1, text: "E   something" }]);

test("a connection failure or timeout is unavailable, with the detail kept out of the outcome's public fields", async () => {
  const { fetchImpl } = stub(async () => {
    throw Object.assign(new Error("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:9") });
  });
  const out = await queryLlm(f, fetchImpl);
  assert.equal(out.kind, "unavailable");
  assert.match(out.kind === "unavailable" ? out.detail : "", /ECONNREFUSED/);
});

test("an HTTP error response is unavailable, not an invalid response: the model never answered", async () => {
  const { fetchImpl } = stub(async () => ({ ok: false, status: 500, body: null, text: "upstream exploded" }));
  assert.equal((await queryLlm(f, fetchImpl)).kind, "unavailable");
});

test("a 200 whose body is not JSON, has no choices, or has non-string content is an invalid response", async () => {
  const notJson: LlmFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("x");
    },
    text: async () => "",
  });
  assert.equal((await queryLlm(f, notJson)).kind, "invalid-response");
  const { fetchImpl: noChoices } = stub(async () => ({ ok: true, status: 200, body: { id: "x" } }));
  assert.equal((await queryLlm(f, noChoices)).kind, "invalid-response");
  const { fetchImpl: numberContent } = stub(ok(42));
  assert.equal((await queryLlm(f, numberContent)).kind, "invalid-response");
});

test("a valid reply comes back as a verdict outcome", async () => {
  const { fetchImpl } = stub(ok(JSON.stringify({ verdict: "UNVERIFIED", confidence: "low", explanation: "no" })));
  assert.deepEqual(await queryLlm(f, fetchImpl), {
    kind: "verdict",
    verdict: "UNVERIFIED",
    confidence: "low",
    explanation: "no",
  });
});

test("the request body carries the built content as the user message and nothing else from the failure", async () => {
  const withContext = failure([{ startLine: 1, endLine: 1, text: "E   primary" }], "captured SECRET_CTX");
  const { fetchImpl, calls } = stub(ok(JSON.stringify({ verdict: "UNVERIFIED" })));
  await queryLlm(withContext, fetchImpl);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body) as { messages: { role: string; content: string }[] };
  const user = body.messages.find((m) => m.role === "user")!;
  assert.equal(user.content, buildLlmUserContent(withContext).content);
  assert.ok(!calls[0].init.body.includes("SECRET_CTX"));
});

// ---- evidence-quote validation: review of 6796940, P1 ----
//
// parseLlmContent only checks that `evidence` is a non-empty string — it has no
// access to the failure, by design (it stays a pure, network-free function). The
// check that the quote actually appears in what was SENT belongs to queryLlm, which
// does have the failure. These tests go through queryLlm, with a stubbed fetch, so
// they exercise the real integration, not just the parsing.

const dbFailure = failure([{ startLine: 10, endLine: 10, text: "E   AssertionError: expected 200, got 500" }]);

test("a fluent but fabricated explanation is rejected: the quoted evidence does not exist in what was sent", async () => {
  // The reviewer's exact example: a plausible database/memory explanation for a log
  // that never mentions either.
  const { fetchImpl } = stub(
    ok(
      JSON.stringify({
        verdict: "ENVIRONMENT_SIGNAL_DETECTED",
        confidence: "medium",
        explanation: "The database connection failed because the server ran out of memory.",
        evidence: "database connection failed",
      }),
    ),
  );
  const out = await queryLlm(dbFailure, fetchImpl);
  assert.equal(out.kind, "response-rejected");
  assert.match(out.kind === "response-rejected" ? out.detail : "", /not found/i);
});

test("an affirmative verdict with no evidence field at all is rejected end to end, not only at the parsing stage", async () => {
  const { fetchImpl } = stub(
    ok(JSON.stringify({ verdict: "ENVIRONMENT_SIGNAL_DETECTED", confidence: "low", explanation: "x" })),
  );
  assert.equal((await queryLlm(dbFailure, fetchImpl)).kind, "response-rejected");
});

test("a quote that genuinely appears in the sent evidence is accepted, and its original line is attached", async () => {
  const { fetchImpl } = stub(
    ok(
      JSON.stringify({
        verdict: "ENVIRONMENT_SIGNAL_DETECTED",
        confidence: "medium",
        explanation: "An assertion failed on the response status.",
        evidence: "expected 200, got 500",
      }),
    ),
  );
  const out = await queryLlm(dbFailure, fetchImpl);
  assert.equal(out.kind, "verdict");
  assert.equal(out.kind === "verdict" && out.evidence, "expected 200, got 500");
  assert.deepEqual(out.kind === "verdict" ? out.evidenceLocation : undefined, { startLine: 10, endLine: 10 });
});

test("a multi-line quote, and one that starts partway through a multi-line segment, both locate the correct original lines", async () => {
  const multiLine = failure([
    {
      startLine: 20,
      endLine: 23,
      text: "setup line\nE   first line of the error\nE   second line of the error\nmore context",
    },
  ]);
  const twoLineQuote = stub(
    ok(
      JSON.stringify({
        verdict: "ENVIRONMENT_SIGNAL_DETECTED",
        confidence: "low",
        explanation: "x",
        evidence: "E   first line of the error\nE   second line of the error",
      }),
    ),
  );
  const out1 = await queryLlm(multiLine, twoLineQuote.fetchImpl);
  assert.deepEqual(out1.kind === "verdict" ? out1.evidenceLocation : undefined, { startLine: 21, endLine: 22 });

  const laterLineOnly = stub(
    ok(
      JSON.stringify({
        verdict: "ENVIRONMENT_SIGNAL_DETECTED",
        confidence: "low",
        explanation: "x",
        evidence: "more context",
      }),
    ),
  );
  const out2 = await queryLlm(multiLine, laterLineOnly.fetchImpl);
  assert.deepEqual(out2.kind === "verdict" ? out2.evidenceLocation : undefined, { startLine: 23, endLine: 23 });
});

test("a quote that only exists in text the character limit cut away is rejected, not accepted because it 'sounds right'", async () => {
  // The marker genuinely exists in the failure's full original text — this is the
  // point of the test. It must still be rejected, because it is NOT in what was
  // actually sent: "x".repeat(EVIDENCE_CHAR_LIMIT) alone already fills the whole
  // budget, so the marker after it is always past the cut.
  const big =
    "E   AssertionError: expected 200, got 500\n" + "x".repeat(EVIDENCE_CHAR_LIMIT) + "\nTHIS_IS_PAST_THE_CUT";
  const cutFailure = failure([{ startLine: 1, endLine: 2, text: big }]);
  assert.ok(big.includes("THIS_IS_PAST_THE_CUT"), "sanity check: the marker is really in the failure's full text");
  const { content } = buildLlmUserContent(cutFailure);
  assert.ok(!content.includes("THIS_IS_PAST_THE_CUT"), "sanity check: but not in what is actually sent");
  const { fetchImpl } = stub(
    ok(
      JSON.stringify({
        verdict: "ENVIRONMENT_SIGNAL_DETECTED",
        confidence: "low",
        explanation: "x",
        evidence: "THIS_IS_PAST_THE_CUT",
      }),
    ),
  );
  assert.equal((await queryLlm(cutFailure, fetchImpl)).kind, "response-rejected");
});

test("a quote from text with no log position (no segments) is still accepted, just with no location", async () => {
  const noPosition: Failure = { testName: "t", framework: "generic", rawText: "ECONNRESET: socket hang up" };
  const { fetchImpl } = stub(
    ok(
      JSON.stringify({
        verdict: "ENVIRONMENT_SIGNAL_DETECTED",
        confidence: "low",
        explanation: "x",
        evidence: "ECONNRESET",
      }),
    ),
  );
  const out = await queryLlm(noPosition, fetchImpl);
  assert.equal(out.kind, "verdict");
  assert.equal(out.kind === "verdict" ? out.evidenceLocation : "present", undefined);
});

test("UNVERIFIED needs no quote and is never rejected for lacking one, end to end", async () => {
  const { fetchImpl } = stub(
    ok(JSON.stringify({ verdict: "UNVERIFIED", confidence: "low", explanation: "not enough" })),
  );
  const out = await queryLlm(dbFailure, fetchImpl);
  assert.equal(out.kind, "verdict");
  assert.equal(out.kind === "verdict" && out.verdict, "UNVERIFIED");
});

test("the Authorization header is sent only when a key is configured", async () => {
  const previous = process.env.FLAKY_FINDER_API_KEY;
  try {
    process.env.FLAKY_FINDER_API_KEY = "k-123";
    const withKey = stub(ok(JSON.stringify({ verdict: "UNVERIFIED" })));
    await queryLlm(f, withKey.fetchImpl);
    assert.equal(withKey.calls[0].init.headers.Authorization, "Bearer k-123");
    delete process.env.FLAKY_FINDER_API_KEY;
    const noKey = stub(ok(JSON.stringify({ verdict: "UNVERIFIED" })));
    await queryLlm(f, noKey.fetchImpl);
    assert.equal("Authorization" in noKey.calls[0].init.headers, false);
  } finally {
    if (previous === undefined) delete process.env.FLAKY_FINDER_API_KEY;
    else process.env.FLAKY_FINDER_API_KEY = previous;
  }
});
