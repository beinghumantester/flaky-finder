import type { AnalysisResult, Failure } from "./types.js";

// Optional second opinion for the cases the deterministic rules couldn't place.
// Uses any OpenAI-chat-compatible open-weight-model endpoint (Groq, Ollama,
// OpenRouter, ...) — configured via env, never required for the tool to work.
const API_KEY = process.env.FLAKY_FINDER_API_KEY;
const BASE_URL = process.env.FLAKY_FINDER_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.FLAKY_FINDER_MODEL ?? "llama-3.1-8b-instant";

export function hasLlmFallback(): boolean {
  return Boolean(API_KEY);
}

const SYSTEM_PROMPT = `You classify a SINGLE CI test failure. You have exactly one run of evidence, so:
- Say ENVIRONMENT_SIGNAL_DETECTED only if the error text itself names a non-product cause (network, timeout, race, randomness, shared state, date/clock). This means "a known non-product signature is present," NOT "this test is confirmed flaky" — a single log can never prove intermittency, so do not phrase your explanation as proof.
- Say SUSPECTED_REGRESSION only if the failure is a deterministic logic mismatch with NO environment/timing signal at all (e.g. a wrong computed value with no network, timing or ordering involved). This is a lead for a human, not a confirmed bug — say so.
- Otherwise say UNVERIFIED — a single run is not enough evidence to decide, and that is a valid, honest answer.
Reply with ONLY compact JSON: {"verdict":"ENVIRONMENT_SIGNAL_DETECTED"|"SUSPECTED_REGRESSION"|"UNVERIFIED","confidence":"low"|"medium","explanation":"<one sentence, cite the specific text that led you there, and do not claim more than that text establishes>"}`;

export async function classifyWithLlm(failure: Failure): Promise<AnalysisResult> {
  if (!API_KEY) {
    return {
      testName: failure.testName,
      framework: failure.framework,
      verdict: "UNVERIFIED",
      confidence: "none",
      explanation: "No LLM fallback configured (set FLAKY_FINDER_API_KEY) — reporting UNVERIFIED rather than guessing.",
      source: "none",
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: failure.rawText.slice(0, 4000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    const content: string = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content.trim());
    const verdict =
      parsed.verdict === "ENVIRONMENT_SIGNAL_DETECTED" || parsed.verdict === "SUSPECTED_REGRESSION" ? parsed.verdict : "UNVERIFIED";
    // SUSPECTED_REGRESSION is always capped at "low" confidence, no matter what the
    // model claims — a model asserting otherwise would be claiming more certainty
    // than one run of evidence can support, which is exactly the overclaim this
    // tool exists to avoid. Only ENVIRONMENT_SIGNAL_DETECTED (identifying a known
    // signature, not diagnosing intermittency) may reach "medium".
    const confidence = verdict === "SUSPECTED_REGRESSION" ? "low" : parsed.confidence === "medium" ? "medium" : "low";
    return {
      testName: failure.testName,
      framework: failure.framework,
      verdict,
      confidence,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : "LLM gave no explanation.",
      source: "llm",
    };
  } catch (err) {
    return {
      testName: failure.testName,
      framework: failure.framework,
      verdict: "UNVERIFIED",
      confidence: "none",
      explanation: `LLM fallback call failed (${(err as Error).message}) — reporting UNVERIFIED rather than guessing.`,
      source: "none",
    };
  }
}
