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
}

export interface AnalysisResult {
  testName: string;
  framework: Failure["framework"];
  verdict: Verdict;
  /** MatchStrength when source is "rule"; Confidence (the model's own stated confidence) when source is "llm" or "none". See the comments on those two types — they are NOT the same kind of thing, despite sharing a field here. */
  confidence: MatchStrength | Confidence;
  category?: string;
  ruleId?: string;
  evidenceLine?: string;
  explanation: string;
  source: Source;
}
