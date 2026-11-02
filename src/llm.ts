import { Agent, fetch as undiciFetch } from "undici";
import type { AnalysisResult, Confidence, Failure, Verdict } from "./types.js";

// Node's global `fetch` is backed by its OWN internal copy of undici —
// setGlobalDispatcher() from the separately-installed `undici` package does
// not reliably reach it. So we don't touch global fetch at all: we use
// undici's own fetch directly, with the timeout passed explicitly per
// request via `dispatcher`. That's the only way to guarantee it's actually
// applied. Needed because a local "thinking" model (Qwen3 and friends)
// generates reasoning tokens on CPU before it sends anything back, which
// routinely exceeds a default ~30-60s timeout meant for normal HTTP APIs.
const TIMEOUT_MS = Number(process.env.FLAKY_FINDER_TIMEOUT_MS ?? 120_000);
const dispatcher = new Agent({ headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });

// Optional second opinion for the cases the deterministic rules couldn't place.
// Uses any OpenAI-chat-compatible open-weight-model endpoint (Groq, Ollama,
// OpenRouter, ...) — configured via env, never required for the tool to work.
const API_KEY = process.env.FLAKY_FINDER_API_KEY;
const BASE_URL = process.env.FLAKY_FINDER_BASE_URL ?? "https://api.groq.com/openai/v1";
// openai/gpt-oss-20b: OpenAI's open-weight model, served here via Groq. Picked
// over Llama because it's cheap, fast, and — per Groq's live /v1/models
// listing — supports json_mode, so we can ask for guaranteed-valid JSON
// instead of hoping the model formats it right.
const MODEL = process.env.FLAKY_FINDER_MODEL ?? "openai/gpt-oss-20b";
// Set FLAKY_FINDER_JSON_MODE=false if your local endpoint's OpenAI-compat
// layer errors on `response_format` (older Ollama builds, some others).
const JSON_MODE = process.env.FLAKY_FINDER_JSON_MODE !== "false";

export function hasLlmFallback(): boolean {
  return Boolean(API_KEY);
}

const SYSTEM_PROMPT = `You classify a SINGLE CI test failure. You have exactly one run of evidence, so:
- Say ENVIRONMENT_SIGNAL_DETECTED only if the error text itself names a non-product cause (network, timeout, race, randomness, shared state, date/clock). This means "a known non-product signature is present," NOT "this test is confirmed flaky" — a single log can never prove intermittency, so do not phrase your explanation as proof.
- Say SUSPECTED_REGRESSION only if the failure is a deterministic logic mismatch with NO environment/timing signal at all (e.g. a wrong computed value with no network, timing or ordering involved). This is a lead for a human, not a confirmed bug — say so.
- Otherwise say UNVERIFIED — a single run is not enough evidence to decide, and that is a valid, honest answer.
Reply with ONLY compact JSON: {"verdict":"ENVIRONMENT_SIGNAL_DETECTED"|"SUSPECTED_REGRESSION"|"UNVERIFIED","confidence":"low"|"medium","explanation":"<one sentence, cite the specific text that led you there, and do not claim more than that text establishes>"}`;

/**
 * Enforces the constraint that matters most: a model's SELF-REPORTED
 * confidence can never push SUSPECTED_REGRESSION above "low" — that's a
 * code-level cap, not a prompt request the model could ignore or get wrong.
 * Also whitelists the verdict string itself (anything unrecognized falls
 * back to UNVERIFIED) and tolerates a missing/malformed explanation field.
 * Pulled out of classifyWithLlm as a pure function so this logic — the
 * actual safety contract of the LLM step — can be unit tested directly,
 * without mocking a network call. Throws on invalid JSON, same as
 * JSON.parse; classifyWithLlm's catch block turns that into UNVERIFIED.
 */
export function parseLlmContent(content: string): { verdict: Verdict; confidence: Confidence; explanation: string } {
  const parsed = JSON.parse(content.trim());
  const verdict: Verdict =
    parsed?.verdict === "ENVIRONMENT_SIGNAL_DETECTED" || parsed?.verdict === "SUSPECTED_REGRESSION" ? parsed.verdict : "UNVERIFIED";
  const confidence: Confidence = verdict === "SUSPECTED_REGRESSION" ? "low" : parsed?.confidence === "medium" ? "medium" : "low";
  const explanation = typeof parsed?.explanation === "string" ? parsed.explanation : "LLM gave no explanation.";
  return { verdict, confidence, explanation };
}

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
    const res = await undiciFetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      dispatcher,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        // Bounded on purpose: a reasoning model (Qwen3 and friends) can spiral
        // in its internal "thinking" phase without a hard stop, especially
        // when forced into strict JSON output — this caps that regardless of
        // cause. A cut-off mid-reasoning response just fails JSON parsing
        // below, which already falls back to UNVERIFIED rather than hanging.
        max_tokens: Number(process.env.FLAKY_FINDER_MAX_TOKENS ?? 800),
        ...(JSON_MODE ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: failure.rawText.slice(0, 4000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    const content: string = data.choices?.[0]?.message?.content ?? "";
    const { verdict, confidence, explanation } = parseLlmContent(content);
    return {
      testName: failure.testName,
      framework: failure.framework,
      verdict,
      confidence,
      explanation,
      source: "llm",
    };
  } catch (err) {
    // undici's fetch wraps the real reason in `.cause` (e.g. ECONNRESET,
    // UND_ERR_SOCKET, a JSON parse error) behind the generic top-level
    // message "fetch failed" — surface it, or this is undiagnosable.
    const cause = (err as any)?.cause;
    const detail = cause ? `${(err as Error).message}: ${cause.message ?? cause}` : (err as Error).message;
    return {
      testName: failure.testName,
      framework: failure.framework,
      verdict: "UNVERIFIED",
      confidence: "none",
      explanation: `LLM fallback call failed (${detail}) — reporting UNVERIFIED rather than guessing.`,
      source: "none",
    };
  }
}
