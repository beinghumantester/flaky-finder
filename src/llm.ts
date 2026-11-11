import { Agent, fetch as undiciFetch } from "undici";
import type { Confidence, Failure, LineSpan, Verdict } from "./types.js";

// The optional LLM step: any OpenAI-chat-compatible endpoint serving an open-weight
// model (Groq, Ollama, OpenRouter, ...). It is off unless the CLI is given --llm,
// because a configured key is not consent to send CI log text to a hosted provider.
// What is sent, and what the outcome means, is in
// docs/design/failure-evidence-boundaries.md, "Sending evidence to a hosted LLM".

// Node's global `fetch` is backed by its OWN internal copy of undici —
// setGlobalDispatcher() from the separately-installed `undici` package does
// not reliably reach it. So we don't touch global fetch at all: we use
// undici's own fetch directly, with the timeout passed explicitly per
// request via `dispatcher`. Needed because a local "thinking" model (Qwen3 and
// friends) generates reasoning tokens on CPU before it sends anything back,
// which routinely exceeds a default ~30-60s timeout meant for normal HTTP APIs.
const TIMEOUT_MS = Number(process.env.FLAKY_FINDER_TIMEOUT_MS ?? 120_000);
const dispatcher = new Agent({ headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });

// Read when used, not at import, so a test can set the environment first.
function config() {
  return {
    apiKey: process.env.FLAKY_FINDER_API_KEY || undefined,
    baseUrl: process.env.FLAKY_FINDER_BASE_URL ?? "https://api.groq.com/openai/v1",
    // openai/gpt-oss-20b: OpenAI's open-weight model, served here via Groq. Picked
    // over Llama because it's cheap, fast, and — per Groq's live /v1/models
    // listing — supports json_mode, so we can ask for guaranteed-valid JSON
    // instead of hoping the model formats it right.
    model: process.env.FLAKY_FINDER_MODEL ?? "openai/gpt-oss-20b",
    // Set FLAKY_FINDER_JSON_MODE=false if your local endpoint's OpenAI-compat
    // layer errors on `response_format` (older Ollama builds, some others).
    jsonMode: process.env.FLAKY_FINDER_JSON_MODE !== "false",
    maxTokens: Number(process.env.FLAKY_FINDER_MAX_TOKENS ?? 800),
  };
}

export function hasApiKey(): boolean {
  return Boolean(config().apiKey);
}

/** The host evidence would be sent to, for disclosure before the first request. */
export function llmEndpointHost(): string {
  try {
    return new URL(config().baseUrl).host;
  } catch {
    return config().baseUrl;
  }
}

const SYSTEM_PROMPT = `You classify a SINGLE CI test failure. You have exactly one run of evidence, so:
- Say ENVIRONMENT_SIGNAL_DETECTED only if the error text itself names a non-product cause (network, timeout, race, randomness, shared state, date/clock). This means "a known non-product signature is present," NOT "this test is confirmed flaky" — a single log can never prove intermittency, so do not phrase your explanation as proof.
- Say SUSPECTED_REGRESSION only if the failure is a deterministic logic mismatch with NO environment/timing signal at all (e.g. a wrong computed value with no network, timing or ordering involved). This is a lead for a human, not a confirmed bug — say so.
- Otherwise say UNVERIFIED — a single run is not enough evidence to decide, and that is a valid, honest answer.
If you say ENVIRONMENT_SIGNAL_DETECTED or SUSPECTED_REGRESSION, you must also quote, verbatim and unmodified, the exact text from the evidence above that led you there, in the "evidence" field. Do not paraphrase, summarize, or invent text that is not there — a quote that cannot be found in the evidence given to you will be rejected. UNVERIFIED does not need a quote.
Reply with ONLY compact JSON: {"verdict":"ENVIRONMENT_SIGNAL_DETECTED"|"SUSPECTED_REGRESSION"|"UNVERIFIED","confidence":"low"|"medium","explanation":"<one sentence, cite the specific text that led you there, and do not claim more than that text establishes>","evidence":"<verbatim quote from the evidence above; required for ENVIRONMENT_SIGNAL_DETECTED and SUSPECTED_REGRESSION>"}`;

/** At most this many characters of evidence go in one request. Measured in step 8 before any change. */
export const EVIDENCE_CHAR_LIMIT = 4000;

/** A block of evidence exactly as sent (after truncation), with its original lines when known. */
export interface SentEvidenceBlock {
  startLine?: number;
  endLine?: number;
  text: string;
}

/**
 * What the model is given: the failure's primary evidence only, one block per
 * segment with its original line numbers, and a marker wherever lines between two
 * segments were left out. Joining the segments would let the model read text as
 * continuous that never was, the same problem the rules avoid by matching per
 * segment. Context, diagnostics and unattributed signals are never included.
 *
 * `sentBlocks` is exactly what was actually included (post-truncation), so a later
 * check of the model's own evidence quote searches only text the model truly saw —
 * never the full original segment if the limit cut part of it away.
 */
export function buildLlmUserContent(failure: Failure): {
  content: string;
  evidenceChars: number;
  cut: boolean;
  sentBlocks: SentEvidenceBlock[];
} {
  const segments = failure.segments ?? [{ startLine: undefined, endLine: undefined, text: failure.rawText }];
  const parts: string[] = [
    `Failure: ${failure.testName} (${failure.framework})`,
    "Primary evidence, with original log line numbers:",
  ];
  const sentBlocks: SentEvidenceBlock[] = [];
  let budget = EVIDENCE_CHAR_LIMIT;
  let evidenceChars = 0;
  let cut = false;
  let previousEnd: number | undefined;
  for (const seg of segments) {
    if (previousEnd !== undefined && seg.startLine !== undefined && seg.startLine > previousEnd + 1) {
      parts.push(`[lines ${previousEnd + 1}-${seg.startLine - 1} left out: captured output, not evidence]`);
    }
    const header = seg.startLine !== undefined ? `[lines ${seg.startLine}-${seg.endLine}]` : "[evidence]";
    if (budget <= 0) {
      cut = true;
      break;
    }
    let text = seg.text;
    if (text.length > budget) {
      text = text.slice(0, budget);
      cut = true;
    }
    budget -= text.length;
    evidenceChars += text.length;
    parts.push(header, text);
    sentBlocks.push({ startLine: seg.startLine, endLine: seg.endLine, text });
    previousEnd = seg.endLine;
  }
  if (cut) parts.push(`[evidence cut at ${EVIDENCE_CHAR_LIMIT} characters]`);
  return { content: parts.join("\n"), evidenceChars, cut, sentBlocks };
}

/**
 * Finds a model's quoted evidence inside what was actually sent. Not found at all is
 * reported separately from found-but-with-no-line-info (text with no log position),
 * so the caller can tell a rejection from a verdict that simply has no location to
 * attach.
 */
function locateEvidenceQuote(sentBlocks: SentEvidenceBlock[], quote: string): { found: boolean; location?: LineSpan } {
  for (const block of sentBlocks) {
    const index = block.text.indexOf(quote);
    if (index < 0) continue;
    if (block.startLine === undefined) return { found: true };
    const linesBefore = block.text.slice(0, index).split("\n").length - 1;
    const linesWithin = quote.split("\n").length - 1;
    return {
      found: true,
      location: { startLine: block.startLine + linesBefore, endLine: block.startLine + linesBefore + linesWithin },
    };
  }
  return { found: false };
}

// What the LLM step produced. A provider failure and a model's own abstention are
// different events and never share a kind: after a timeout the model may never have
// read the evidence; after a valid UNVERIFIED it read it and abstained.
export type LlmOutcome =
  | {
      kind: "verdict";
      verdict: Verdict;
      confidence: Confidence;
      explanation: string;
      /** The model's verbatim quote, once queryLlm has confirmed it is real. Trimmed. */
      evidence?: string;
      /** `evidence`'s original lines, when the failure carried a log position. */
      evidenceLocation?: LineSpan;
    }
  | { kind: "unavailable" | "invalid-response" | "response-rejected"; detail: string };

/**
 * Turns the model's reply into an outcome, enforcing the constraint that matters
 * most: a model's SELF-REPORTED confidence can never push SUSPECTED_REGRESSION above
 * "low" — a code-level cap, not a prompt request the model could ignore. Anything
 * that is not JSON, or has no recognized verdict, is `invalid-response`; a reply
 * that parses but has a field of the wrong type is `response-rejected`. An
 * ENVIRONMENT_SIGNAL_DETECTED or SUSPECTED_REGRESSION verdict — one that claims a
 * cause — must come with a non-empty `evidence` quote, or it is `response-rejected`
 * too: an explanation is not itself checked against the evidence (this function has
 * no access to it), only required to point at some. Nothing here ever becomes a
 * verdict by accident. Pure, so the contract is unit tested without a network. The
 * quote is checked against what was actually sent by queryLlm, which does have the
 * failure — see `locateEvidenceQuote`.
 */
export function parseLlmContent(content: string): LlmOutcome {
  if (content.trim() === "") return { kind: "invalid-response", detail: "empty reply" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return { kind: "invalid-response", detail: "reply is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { kind: "invalid-response", detail: "reply is not an object" };
  const reply = parsed as Record<string, unknown>;
  const verdict = reply.verdict;
  if (verdict !== "ENVIRONMENT_SIGNAL_DETECTED" && verdict !== "SUSPECTED_REGRESSION" && verdict !== "UNVERIFIED") {
    return { kind: "invalid-response", detail: "no recognized verdict" };
  }
  if (reply.confidence !== undefined && typeof reply.confidence !== "string") {
    return { kind: "response-rejected", detail: "confidence is not a string" };
  }
  if (reply.explanation !== undefined && typeof reply.explanation !== "string") {
    return { kind: "response-rejected", detail: "explanation is not a string" };
  }
  if (reply.evidence !== undefined && typeof reply.evidence !== "string") {
    return { kind: "response-rejected", detail: "evidence is not a string" };
  }
  const evidence = typeof reply.evidence === "string" ? reply.evidence.trim() : "";
  const makesACausalClaim = verdict === "ENVIRONMENT_SIGNAL_DETECTED" || verdict === "SUSPECTED_REGRESSION";
  if (makesACausalClaim && evidence === "") {
    return { kind: "response-rejected", detail: "no evidence quote for a verdict that claims a cause" };
  }
  const confidence: Confidence =
    verdict === "SUSPECTED_REGRESSION" ? "low" : reply.confidence === "medium" ? "medium" : "low";
  const explanation = typeof reply.explanation === "string" ? reply.explanation : "LLM gave no explanation.";
  return { kind: "verdict", verdict, confidence, explanation, ...(evidence ? { evidence } : {}) };
}

/** The part of fetch this module uses, so a test can hand in a stub and inspect the real request body. */
export type LlmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; dispatcher?: Agent },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const defaultFetch: LlmFetch = (url, init) => undiciFetch(url, init);

/**
 * Sends one failure's primary evidence and returns the outcome. Never throws: a
 * provider error, timeout or connection failure is `unavailable`, with the detail
 * kept for a debug channel, never for the user-facing explanation (it can echo a URL
 * or the request).
 */
export async function queryLlm(failure: Failure, fetchImpl: LlmFetch = defaultFetch): Promise<LlmOutcome> {
  const { apiKey, baseUrl, model, jsonMode, maxTokens } = config();
  const { content, sentBlocks } = buildLlmUserContent(failure);
  let data: unknown;
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      dispatcher,
      body: JSON.stringify({
        model,
        temperature: 0,
        // Bounded on purpose: a reasoning model can spiral in its internal
        // "thinking" phase without a hard stop. A cut-off reply fails to parse
        // below, which is an invalid response, not a verdict.
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      }),
    });
    if (!res.ok) return { kind: "unavailable", detail: `HTTP ${res.status}: ${await res.text()}` };
    try {
      data = await res.json();
    } catch (err) {
      return { kind: "invalid-response", detail: `response body is not JSON: ${(err as Error).message}` };
    }
  } catch (err) {
    // undici's fetch wraps the real reason in `.cause` (e.g. ECONNRESET,
    // UND_ERR_SOCKET) behind the generic top-level message "fetch failed".
    const cause = (err as { cause?: { message?: string } } | undefined)?.cause;
    const detail = cause ? `${(err as Error).message}: ${cause.message ?? cause}` : (err as Error).message;
    return { kind: "unavailable", detail };
  }
  const reply = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof reply !== "string")
    return { kind: "invalid-response", detail: "unexpected response shape: no choices[0].message.content" };
  const outcome = parseLlmContent(reply);
  if (outcome.kind !== "verdict" || outcome.evidence === undefined) return outcome;
  // A quote is only as trustworthy as the text it is checked against: search the
  // evidence actually sent (sentBlocks), never the failure's full original text —
  // otherwise a quote the character limit cut away would still "verify".
  const { found, location } = locateEvidenceQuote(sentBlocks, outcome.evidence);
  if (!found) {
    return {
      kind: "response-rejected",
      detail: `evidence quote not found in the evidence sent: "${outcome.evidence}"`,
    };
  }
  return { ...outcome, ...(location ? { evidenceLocation: location } : {}) };
}
