import type {
  AbstainReason,
  AnalysisResult,
  Failure,
  LogSignal,
  PublicExtraction,
  Rule,
  RuleMatch,
  UnattributedSignal,
} from "./types.js";
import { classifyWithRules, findRuleMatches, RULES } from "./rules.js";
import type { LlmOutcome } from "./llm.js";

// The analysis pipeline for one failure: eligibility, then rules, then the LLM, in
// that order. The last stage that ran sets the reason. An ineligible observation
// stops at the first stage, so it never reaches a classifier, and its signals are
// listed as unattributed instead. This is the one place the final outcome table in
// docs/design/failure-evidence-boundaries.md is implemented.

export type LlmClassifier = (failure: Failure) => Promise<LlmOutcome>;

// One fixed sentence per reason. Provider details never go here: an error message
// can echo a URL or the request, and the reason code is the contract, not the text.
export const ABSTAIN_EXPLANATIONS: Record<
  Exclude<AbstainReason, "no-rule-matched" | "rule-abstained" | "insufficient-evidence">,
  string
> = {
  "boundary-unknown":
    "No test framework structure was recognized, so this text cannot be attributed to a failure. Any known signatures in it are listed below, but none can decide a verdict.",
  "boundary-truncated":
    "The log ends before this failure's end marker, so the tool cannot establish which lines belong to it. Any known signatures in it are listed below, but none can decide a verdict.",
  "context-only-signal":
    "A known signature appears only in captured output, which is context, not primary evidence of this failure. It is listed below, but cannot decide the verdict.",
  "llm-unavailable":
    "The LLM classifier could not be reached, so this failure was not evaluated by it. Reporting UNVERIFIED rather than guessing.",
  "llm-invalid-response":
    "The LLM classifier returned a reply that was not a recognizable answer. Reporting UNVERIFIED rather than guessing.",
  "llm-response-rejected": "The LLM classifier's answer failed validation. Reporting UNVERIFIED rather than guessing.",
};

/**
 * Only complete and attributable evidence can decide a verdict. Text with no
 * extraction (JUnit failure text, a direct caller's own string) has no log position
 * and keeps today's behaviour: it is treated as the caller's chosen evidence.
 */
export function isEligible(failure: Failure): boolean {
  if (!failure.extraction) return true;
  return failure.extraction.boundary === "complete" && (failure.segments?.length ?? 0) > 0;
}

function toUnattributed(matches: RuleMatch[], where: UnattributedSignal["where"]): UnattributedSignal[] {
  return matches.map((m) => ({
    ruleId: m.ruleId,
    ruleOrigin: m.ruleOrigin,
    category: m.category,
    matchStrength: m.matchStrength,
    evidenceLine: m.evidenceLine,
    line: m.evidenceLocation?.startLine ?? 0,
    where,
  }));
}

function toPublicExtraction(failure: Failure): PublicExtraction | undefined {
  const e = failure.extraction;
  if (!e) return undefined;
  return {
    method: e.method,
    boundary: e.boundary,
    span: e.span,
    phase: e.phase,
    ...(e.attempts ? { attempts: e.attempts } : {}),
    ...(e.contextSpans
      ? { contextSpans: e.contextSpans.map((c) => ({ startLine: c.startLine, endLine: c.endLine })) }
      : {}),
  };
}

function withProvenance(failure: Failure, result: AnalysisResult, signals: UnattributedSignal[]): AnalysisResult {
  if (!failure.extraction) return result;
  return {
    ...result,
    unattributedSignals: signals,
    extraction: toPublicExtraction(failure),
    segments: failure.segments ?? [],
  };
}

function abstain(failure: Failure, reason: AbstainReason, explanation: string): AnalysisResult {
  return {
    testName: failure.testName,
    framework: failure.framework,
    verdict: "UNVERIFIED",
    confidence: "none",
    explanation,
    source: "none",
    abstainReason: reason,
  };
}

/** Rule matches in the failure's captured output: visible, never decisive. */
function contextSignals(failure: Failure, rules: Rule[]): UnattributedSignal[] {
  const spans = failure.extraction?.contextSpans ?? [];
  return toUnattributed(
    findRuleMatches(
      spans.map((c) => ({ text: c.text, firstLine: c.startLine })),
      rules,
    ),
    "context",
  );
}

/**
 * Classifies one failure. `llm` is null when the LLM step is off. A failed LLM call
 * affects only this failure: the outcome says so, and the caller goes on to the next.
 */
export async function analyzeFailure(
  failure: Failure,
  customRules: Rule[] = [],
  llm: LlmClassifier | null = null,
): Promise<AnalysisResult> {
  const rules = [...customRules, ...RULES];

  if (!isEligible(failure)) {
    const reason: AbstainReason =
      failure.extraction?.boundary === "truncated" ? "boundary-truncated" : "boundary-unknown";
    const signals = toUnattributed(
      findRuleMatches(
        (failure.segments ?? []).map((s) => ({ text: s.text, firstLine: s.startLine })),
        rules,
      ),
      "ineligible-block",
    );
    return withProvenance(failure, abstain(failure, reason, ABSTAIN_EXPLANATIONS[reason]), signals);
  }

  const signals = contextSignals(failure, rules);
  const byRules = classifyWithRules(failure, customRules);
  if (byRules.source === "rule") return withProvenance(failure, byRules, signals);

  if (llm === null) {
    if (signals.length > 0) {
      return withProvenance(
        failure,
        abstain(failure, "context-only-signal", ABSTAIN_EXPLANATIONS["context-only-signal"]),
        signals,
      );
    }
    return withProvenance(failure, byRules, signals);
  }

  const outcome = await llm(failure);
  if (outcome.kind === "verdict") {
    const result: AnalysisResult = {
      testName: failure.testName,
      framework: failure.framework,
      verdict: outcome.verdict,
      confidence: outcome.confidence,
      explanation: outcome.explanation,
      source: "llm",
      // The model's quoted evidence, once queryLlm has confirmed it is real text the
      // model actually saw (never just trusted): same fields a rule match uses, so a
      // reader does not need to know which classifier produced a result to find its
      // evidence (review of 6796940, P1).
      ...(outcome.evidence !== undefined ? { evidenceLine: outcome.evidence } : {}),
      ...(outcome.evidenceLocation ? { evidenceLocation: outcome.evidenceLocation } : {}),
      ...(outcome.verdict === "UNVERIFIED" ? { abstainReason: "insufficient-evidence" as const } : {}),
    };
    return withProvenance(failure, result, signals);
  }
  const reason: AbstainReason =
    outcome.kind === "unavailable"
      ? "llm-unavailable"
      : outcome.kind === "invalid-response"
        ? "llm-invalid-response"
        : "llm-response-rejected";
  return withProvenance(failure, abstain(failure, reason, ABSTAIN_EXPLANATIONS[reason]), signals);
}

/**
 * Every rule match in the log that decided nothing, one entry per rule: matches in
 * context, in ineligible blocks, and in the lines outside every failure's span.
 * Visible so a reader can see what was found and not used; read by no classifier.
 */
export function collectLogSignals(
  lines: string[],
  failures: Failure[],
  results: AnalysisResult[],
  customRules: Rule[],
): LogSignal[] {
  const rules = [...customRules, ...RULES];
  const found = new Map<string, LogSignal>();
  const add = (s: Omit<LogSignal, "count">) => {
    const key = `${s.ruleOrigin}:${s.ruleId}`;
    const existing = found.get(key);
    if (existing) {
      existing.count += 1;
      if (s.firstLine < existing.firstLine) {
        existing.firstLine = s.firstLine;
        existing.firstEvidenceLine = s.firstEvidenceLine;
      }
    } else found.set(key, { ...s, count: 1 });
  };
  for (const r of results) {
    for (const u of r.unattributedSignals ?? []) {
      add({
        ruleId: u.ruleId,
        ruleOrigin: u.ruleOrigin,
        category: u.category,
        matchStrength: u.matchStrength,
        firstLine: u.line,
        firstEvidenceLine: u.evidenceLine,
      });
    }
  }
  // Lines covered by no observation at all, as runs of consecutive lines.
  const covered = new Array<boolean>(lines.length).fill(false);
  for (const f of failures) {
    const span = f.extraction?.span;
    if (!span) continue;
    for (let i = span.startLine - 1; i < Math.min(span.endLine, lines.length); i++) covered[i] = true;
  }
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart < 0) return;
    const text = lines.slice(runStart, end).join("\n");
    for (const m of findRuleMatches([{ text, firstLine: runStart + 1 }], rules)) {
      // Count every matching line in the run, not only the first.
      const count = lines
        .slice(runStart, end)
        .filter((l) => rules.find((r) => r.id === m.ruleId)!.pattern.test(l)).length;
      for (let k = 0; k < Math.max(count, 1); k++) {
        add({
          ruleId: m.ruleId,
          ruleOrigin: m.ruleOrigin,
          category: m.category,
          matchStrength: m.matchStrength,
          firstLine: m.evidenceLocation?.startLine ?? runStart + 1,
          firstEvidenceLine: m.evidenceLine,
        });
      }
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (covered[i]) flush(i);
    else if (runStart < 0) runStart = i;
  }
  flush(lines.length);
  return [...found.values()].sort((a, b) => a.firstLine - b.firstLine || a.ruleId.localeCompare(b.ruleId));
}
