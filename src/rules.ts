import type { Rule, Failure, AnalysisResult } from "./types.js";

// Every rule fires on a SPECIFIC, well-known non-product failure signature —
// never on a bare assertion mismatch. A rule that fired on "expected 1 to
// equal 2" would just be guessing with extra steps.
//
// IMPORTANT: a rule's job is to identify WHAT SIGNATURE IS PRESENT, not to
// decide whether the test is actually flaky. "A connection reset happened"
// is something the log can prove. "This test is intermittent" is something
// only rerun history or code review can establish — a single log never can,
// no matter how recognizable the error text is. So `explain()` below
// describes the signature only; the "this isn't proof" caveat is added once,
// uniformly, in classifyWithRules — not duplicated (and risked drifting) in
// every rule.
export const RULES: Rule[] = [
  {
    id: "network-reset",
    category: "network",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "high",
    pattern: /ECONNRESET|Connection reset by peer|socket hang up/i,
    explain: (line) => `The connection was reset mid-request (${line.trim()}) — a network-layer signature.`,
  },
  {
    id: "port-in-use",
    category: "resource",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "high",
    pattern: /EADDRINUSE|address already in use/i,
    explain: (line) => `A port was still held by another process on the runner (${line.trim()}) — a resource-contention signature.`,
  },
  {
    id: "stale-dom-element",
    category: "ui-timing",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "high",
    pattern: /stale element reference|Element is not attached to the DOM/i,
    explain: (line) => `The DOM node was replaced between lookup and interaction (${line.trim()}) — a UI-timing signature.`,
  },
  {
    id: "dns-resolution",
    category: "network",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "medium",
    pattern: /ENOTFOUND|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)/i,
    explain: (line) => `DNS resolution failed (${line.trim()}) — a network-layer signature.`,
  },
  {
    id: "timeout-exceeded",
    category: "timing",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "medium",
    pattern: /ETIMEDOUT|Test timeout of \d+ms exceeded|Timed out retrying/i,
    explain: (line) =>
      `The test hit a timeout rather than a wrong value (${line.trim()}) — a timing signature. This says nothing about WHY it timed out: a slow runner, a too-tight limit, and a real regression that never renders the awaited element all produce the exact same message.`,
  },
  {
    id: "locator-target-closed",
    category: "ui-timing",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "medium",
    pattern: /Target closed|element.*detached|waiting for locator/i,
    explain: (line) => `The target element/page was gone by the time the action ran (${line.trim()}) — a UI-timing signature.`,
  },
  {
    id: "resource-exhaustion",
    category: "resource",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "medium",
    pattern: /EMFILE|too many open files|ENOMEM|out of memory/i,
    explain: (line) => `The runner ran out of a shared resource (${line.trim()}) — a resource-contention signature.`,
  },
  {
    id: "db-contention",
    category: "concurrency",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "medium",
    pattern: /database is locked|deadlock detected|could not serialize access/i,
    explain: (line) => `Database-level lock contention was reported (${line.trim()}) — a concurrency signature.`,
  },
  {
    id: "teardown-hang",
    category: "teardown",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "low",
    pattern: /did not exit one second after the test run|did not exit cleanly|Force exiting Jest/i,
    explain: (line) => `This is a process-teardown warning, not a failed assertion (${line.trim()}) — a dangling-handle signature.`,
  },
  {
    id: "unique-constraint-pollution",
    category: "test-pollution",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    confidence: "low",
    pattern: /duplicate key value violates unique constraint|UNIQUE constraint failed/i,
    explain: (line) => `A uniqueness violation was reported (${line.trim()}) — a signature consistent with leftover state from a prior test, among other causes.`,
  },
  {
    id: "wall-clock-sensitive",
    category: "time-sensitive",
    verdict: "UNVERIFIED",
    confidence: "low",
    pattern: /RangeError: Invalid time value|toLocaleDateString|Invalid Date/i,
    explain: (line) =>
      `The failure touches date/time formatting (${line.trim()}). Could be a real bug or a test that isn't pinned to a fixed clock — a single run can't tell you which.`,
  },
];

// Appended once, uniformly, to every rule-based ENVIRONMENT_SIGNAL_DETECTED
// result — see the comment on RULES above for why this lives here and not
// inside each rule's explain().
const SIGNAL_NOT_PROOF_CAVEAT =
  "This identifies a known non-product signature in the failure text — it is NOT proof the test is actually intermittent. Only rerun history or code review can establish that; treat this as a lead to check, not a confirmed diagnosis.";

function findEvidenceLine(rawText: string, pattern: RegExp): string {
  const line = rawText.split("\n").find((l) => pattern.test(l));
  return (line ?? rawText.slice(0, 160)).trim();
}

/**
 * Pure, deterministic, auditable classification. No model call, no guessing:
 * a failure that matches no known signature is UNVERIFIED, never rounded up
 * to SUSPECTED_REGRESSION or down to ENVIRONMENT_SIGNAL_DETECTED.
 */
export function classifyWithRules(failure: Failure): AnalysisResult {
  for (const rule of RULES) {
    if (rule.pattern.test(failure.rawText)) {
      const evidenceLine = findEvidenceLine(failure.rawText, rule.pattern);
      const base = rule.explain(evidenceLine);
      return {
        testName: failure.testName,
        framework: failure.framework,
        verdict: rule.verdict,
        confidence: rule.confidence,
        category: rule.category,
        ruleId: rule.id,
        evidenceLine,
        explanation: rule.verdict === "ENVIRONMENT_SIGNAL_DETECTED" ? `${base} ${SIGNAL_NOT_PROOF_CAVEAT}` : base,
        source: "rule",
      };
    }
  }
  return {
    testName: failure.testName,
    framework: failure.framework,
    verdict: "UNVERIFIED",
    confidence: "none",
    explanation:
      "No known failure signature matched. A plain assertion mismatch from a single run can't honestly be called a confirmed bug OR an environment issue — that needs a rerun-history check or code review.",
    source: "none",
  };
}
