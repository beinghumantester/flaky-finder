// ENVIRONMENT_SIGNAL_DETECTED means exactly what it says: a known non-product
// failure signature was found in the text. It does NOT mean "proven flaky" —
// a single log can never establish that a failure is intermittent, only that
// it carries a signature commonly associated with non-determinism. Likewise
// SUSPECTED_REGRESSION is a lead for a human, not a confirmed diagnosis.
export type Verdict = "ENVIRONMENT_SIGNAL_DETECTED" | "SUSPECTED_REGRESSION" | "UNVERIFIED";
export type Confidence = "high" | "medium" | "low" | "none";
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
  confidence: Confidence;
  /** Matched against Failure.rawText. Must be specific enough not to fire on ordinary assertion failures. */
  pattern: RegExp;
  explain: (evidenceLine: string) => string;
}

export interface AnalysisResult {
  testName: string;
  framework: Failure["framework"];
  verdict: Verdict;
  confidence: Confidence;
  category?: string;
  ruleId?: string;
  evidenceLine?: string;
  explanation: string;
  source: Source;
}
