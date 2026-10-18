export type Verdict = "LIKELY_FLAKY" | "LIKELY_REAL_BUG" | "UNVERIFIED";
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
