// ENVIRONMENT_SIGNAL_DETECTED means exactly what it says: a known non-product
// failure signature was found in the text. It does NOT mean "proven flaky" —
// a single log can never establish that a failure is intermittent, only that
// it carries a signature commonly associated with non-determinism. Likewise
// SUSPECTED_REGRESSION is a lead for a human, not a confirmed diagnosis.
export type Verdict = "ENVIRONMENT_SIGNAL_DETECTED" | "SUSPECTED_REGRESSION" | "UNVERIFIED";
// A rule's matching is plain string/regex presence-or-absence — there is no
// statistical score behind it, so calling it "confidence" would claim a
// calculation that doesn't exist. MatchStrength says what it actually is:
// how specific/unambiguous the matched text is as a signature.
//   exact  — an error code or exception name essentially unique to this cause
//            (e.g. ECONNRESET, EADDRINUSE)
//   strong — a specific recognizable phrase, slightly more interpretive
//   weak   — a looser or more generic phrase, more room for a false match
export type MatchStrength = "exact" | "strong" | "weak";
// The LLM step's own stated confidence in ITS classification — a different,
// legitimate use of "confidence" (the model's self-report), not a score we
// calculated ourselves. Always "none" when no model call was made at all.
export type Confidence = "medium" | "low" | "none";
export type Source = "rule" | "llm" | "none";

export interface Failure {
  testName: string;
  framework: "pytest" | "jest" | "playwright" | "generic";
  rawText: string;
}

export interface Rule {
  id: string;
  category: string;
  verdict: Verdict;
  matchStrength: MatchStrength;
  /** Matched against Failure.rawText. Must be specific enough not to fire on ordinary assertion failures. */
  pattern: RegExp;
  explain: (evidenceLine: string) => string;
  /** "custom" for a rule loaded from a team's rules file (custom-rules.ts); omitted for the built-in rules in rules.ts. */
  origin?: RuleOrigin;
}

export type RuleOrigin = "builtin" | "custom";

/** A rule that matched a failure's text — the winning rule's fields live on AnalysisResult itself; this shape is used for the others. */
export interface RuleMatch {
  ruleId: string;
  ruleOrigin: RuleOrigin;
  category: string;
  verdict: Verdict;
  matchStrength: MatchStrength;
  evidenceLine: string;
}

export interface AnalysisResult {
  testName: string;
  framework: Failure["framework"];
  verdict: Verdict;
  /** MatchStrength when source is "rule"; Confidence (the model's own stated confidence) when source is "llm" or "none". See the comments on those two types — they are NOT the same kind of thing, despite sharing a field here. */
  confidence: MatchStrength | Confidence;
  category?: string;
  ruleId?: string;
  /** Set whenever source is "rule": whether the matching rule shipped with flaky-finder or came from a custom rules file. */
  ruleOrigin?: RuleOrigin;
  evidenceLine?: string;
  explanation: string;
  source: Source;
  /**
   * Present (possibly empty) whenever source is "rule": every OTHER rule that
   * also matched this failure, in precedence order. They did not decide the
   * verdict (first match wins) but are reported so no matching evidence is
   * hidden.
   */
  alsoMatched?: RuleMatch[];
}

// A FailureGroup is a separate, additional VIEW over an existing array of
// AnalysisResults — grouped by which rule decided their verdict. It never
// changes a result: see src/failure-grouping.ts for the read-only contract.
// "These failures matched the same rule" is an observation the data
// supports directly. "These failures share one real-world cause" is a
// hypothesis the data does NOT support on its own — two independent
// failures can trivially produce the identical signature, and a single
// real incident can just as easily produce several different ones. That's
// why `limitation` is a fixed, always-present sentence, not something a
// reader has to infer from the group existing at all.
export interface FailureGroup {
  /** Always "rule_id" today — the only grouping key this version implements. A distinct literal, not a free string, so adding a second grouping method later is a visible type change, not a silent string. */
  groupingMethod: "rule_id";
  ruleId: string;
  ruleOrigin: RuleOrigin;
  /** The grouped rule's own matchStrength. Weak-strength rules are excluded from grouping by default — see failure-grouping.ts. */
  matchStrength: MatchStrength;
  category: string;
  /** Number of failure OBSERVATIONS in this group — not distinct tests. A test that fails twice under the same rule (e.g. a retry-plugin duplicate) counts twice here. */
  occurrenceCount: number;
  /** Number of DISTINCT test identities in this group. Can be less than occurrenceCount — see occurrenceCount's comment. */
  affectedTestCount: number;
  /** testName values (there is no classname available at this stage — unlike history's composite test id). */
  affectedTestIds: string[];
  /** Every observation's original AnalysisResult, unmodified — grouping is read-only. */
  observations: AnalysisResult[];
  limitation: string;
}
