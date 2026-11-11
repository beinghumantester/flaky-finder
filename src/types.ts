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

/** 1-based and inclusive, in the original log file. See log-cleaning.ts for why cleaned line indexes are safe to use. */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

// What was observed about a block's end, not a confidence score:
//   complete  — a framework marker ended the block
//   truncated — the log ended before any end marker
//   unknown   — no framework structure was recognized
export type BoundaryState = "complete" | "truncated" | "unknown";
export type FailurePhase = "setup" | "call" | "teardown" | "collection" | "unknown";

// Where a failure's evidence came from. See docs/design/failure-evidence-boundaries.md.
export interface FailureExtraction {
  /** Which extractor produced this, e.g. "pytest-failures-section". */
  method: string;
  boundary: BoundaryState;
  /** The whole observation. */
  span: LineSpan;
  phase: FailurePhase;
  /** One span per retry, in order. */
  attempts?: LineSpan[];
  /** Captured output: preserved, but never primary evidence. */
  contextSpans?: ContextSpan[];
}

/** A LineSpan that also carries its text, so context keeps its line boundaries and source location. */
export interface ContextSpan extends LineSpan {
  text: string;
}

/** One unbroken run of primary evidence. Its text is exactly its lines. */
export interface EvidenceSegment extends LineSpan {
  text: string;
}

export interface Failure {
  testName: string;
  framework: "pytest" | "jest" | "playwright" | "generic";
  /** Derived from `segments` (joined with "\n") when they exist. Never used to find a line location. */
  rawText: string;
  /** Absent for text with no log position, such as JUnit failure text or a direct caller's own string. */
  extraction?: FailureExtraction;
  /** Primary evidence in log order. The source of truth for locations, when present. */
  segments?: EvidenceSegment[];
  /**
   * The file a bullet-style testName belongs to (currently Jest only, from its
   * preceding `FAIL`/`PASS` line). `testName` alone is not unique across files — two
   * suites can share a `describe` block and test title. Used only to disambiguate
   * identity during merging (merge.ts); never copied onto AnalysisResult or any
   * other public output. pytest and Playwright already encode enough of their own
   * location in `testName` and do not set this.
   */
  suiteFile?: string;
}

/** Something extraction declined to treat as a failure. Never read by the classifier. */
export interface Diagnostic {
  /** For example "pytest-header-outside-failure-section". */
  code: string;
  message: string;
  /** 1-based line in the original log. */
  line?: number;
  /** Internal only: it may hold anything, so it must never reach user-facing output. */
  text?: string;
}

export interface ExtractionResult {
  failures: Failure[];
  diagnostics: Diagnostic[];
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
  /** Original log lines of `evidenceLine`. Present when the failure carries segments. */
  evidenceLocation?: LineSpan;
}

// Why an UNVERIFIED result is UNVERIFIED. Each reason has exactly one owner, and the
// last stage that ran sets it. See docs/design/failure-evidence-boundaries.md,
// "Parser uncertainty stays separate from classification uncertainty".
export type AbstainReason =
  | "boundary-unknown" // extraction: no failure structure, or two structures claimed the same lines
  | "boundary-truncated" // extraction: the block's end was never seen
  | "context-only-signal" // rule engine: a rule matched only in captured output
  | "no-rule-matched" // rule engine
  | "rule-abstained" // rule engine: a rule matched, but its own verdict is UNVERIFIED
  | "insufficient-evidence" // LLM: it evaluated the evidence and returned a valid UNVERIFIED
  | "llm-unavailable" // provider: unreachable, error response, or timeout
  | "llm-invalid-response" // LLM: not JSON, empty, unexpected shape, or no recognized verdict
  | "llm-response-rejected"; // LLM: parsed, but a field has the wrong type

/** A rule match that could not decide a verdict, listed so it is visible but never used. */
export interface UnattributedSignal {
  ruleId: string;
  ruleOrigin: RuleOrigin;
  category: string;
  matchStrength: MatchStrength;
  evidenceLine: string;
  /** Original log line of `evidenceLine`. */
  line: number;
  /** "context": captured output of an eligible failure. "ineligible-block": an unknown or truncated observation. */
  where: "context" | "ineligible-block";
}

/** One rule's matches across the whole log that decided nothing: in context, in ineligible blocks, or outside every failure. */
export interface LogSignal {
  ruleId: string;
  ruleOrigin: RuleOrigin;
  category: string;
  matchStrength: MatchStrength;
  /** Matching lines, across the log. */
  count: number;
  firstLine: number;
  firstEvidenceLine: string;
}

/** FailureExtraction as printed: context spans keep only their lines, never their text. */
export interface PublicExtraction {
  method: string;
  boundary: BoundaryState;
  span: LineSpan;
  phase: FailurePhase;
  attempts?: LineSpan[];
  contextSpans?: LineSpan[];
}

/** A Diagnostic as printed: never its text, which may hold anything. Built field by field in public-output.ts. */
export interface PublicDiagnostic {
  code: string;
  message: string;
  line?: number;
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
  /**
   * Text that decided the verdict. When source is "rule", the rule's own match. When
   * source is "llm" and the verdict is ENVIRONMENT_SIGNAL_DETECTED or
   * SUSPECTED_REGRESSION, the model's own verbatim quote — present only once it has
   * been confirmed to actually appear in the evidence sent, never trusted as-is. A
   * verdict that claims a cause and gave no checkable quote is `llm-response-rejected`
   * instead, so this field is never set from an unverified claim.
   */
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
  /** Present whenever verdict is UNVERIFIED. */
  abstainReason?: AbstainReason;
  /**
   * Original log lines of `evidenceLine`. Present when source is "rule" and the
   * failure carries segments, or when source is "llm" and the model's quote was
   * located inside a segment (absent if the failure had no log position to locate it
   * in, which does not by itself make the quote untrustworthy).
   */
  evidenceLocation?: LineSpan;
  /** Present (possibly empty) whenever the failure came from log extraction. Never read by any classifier. */
  unattributedSignals?: UnattributedSignal[];
  /** Where the failure's evidence came from. Present whenever the failure came from log extraction. */
  extraction?: PublicExtraction;
  /** The primary evidence that was classified, with its original line numbers. Present with `extraction`. */
  segments?: EvidenceSegment[];
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
