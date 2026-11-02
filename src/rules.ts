import type { Rule, Failure, AnalysisResult } from "./types.js";

// Bump this whenever a rule's pattern, verdict, or matchStrength changes.
// History storage (history-ingest.ts) records this alongside every stored
// failure signature, so a later change to the ruleset can be told apart from
// a change in actually-observed test behavior — re-classifying old evidence
// with a new ruleset version is a deliberate, visible action, not something
// that happens silently by re-running history analysis.
export const RULESET_VERSION = 1;

// Every rule fires on a SPECIFIC, well-known non-product failure signature —
// never on a bare assertion mismatch. A rule that fired on "expected 1 to
// equal 2" would just be guessing with extra steps.
//
// IMPORTANT: a rule's job is to identify WHAT TEXT IS PRESENT, not to decide
// what category it belongs to or whether the test is actually flaky.
// "A connection reset happened" is something the log can prove. Calling that
// a "network-layer signature" is already an interpretation — a reset can
// originate from the application, an intermediary, or the network, and the
// log alone doesn't disambiguate. So `explain()` below states only the bare
// observation; the category label and the "this isn't proof" caveat are both
// added once, uniformly, in classifyWithRules — not duplicated (and risked
// drifting into overconfident wording) in every rule.
//
// Precedence: rules are checked in array order, first match wins. Order is
// deliberately most-unambiguous-signature-first (an exact error code like
// ECONNRESET first; a loosely-matching phrase like "Target closed" later) —
// so if a failure's text happens to contain more than one known signature,
// the more specific one is reported, not whichever rule happened to be
// written first for unrelated reasons. See
// tests/rules.test.ts's precedence test for this made explicit.
export const RULES: Rule[] = [
  {
    id: "network-reset",
    category: "network",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "exact",
    pattern: /ECONNRESET|Connection reset by peer|socket hang up/i,
    explain: (line) => `The connection was reset mid-request (${line.trim()}).`,
  },
  {
    id: "port-in-use",
    category: "resource",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "exact",
    pattern: /EADDRINUSE|address already in use/i,
    explain: (line) => `A port was still held by another process on the runner (${line.trim()}).`,
  },
  {
    id: "stale-dom-element",
    category: "ui-timing",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "exact",
    pattern: /stale element reference|Element is not attached to the DOM/i,
    explain: (line) => `The DOM node was replaced between lookup and interaction (${line.trim()}).`,
  },
  {
    id: "dns-resolution",
    category: "network",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "strong",
    pattern: /ENOTFOUND|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)/i,
    explain: (line) => `DNS resolution failed (${line.trim()}).`,
  },
  {
    id: "timeout-exceeded",
    category: "timing",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "strong",
    pattern: /ETIMEDOUT|Test timeout of \d+ms exceeded|Timed out retrying/i,
    explain: (line) =>
      `The test hit a timeout rather than a wrong value (${line.trim()}). This says nothing about WHY it timed out: a slow runner, a too-tight limit, and a real regression that never renders the awaited element all produce the exact same message.`,
  },
  {
    id: "locator-target-closed",
    category: "ui-timing",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "strong",
    pattern: /Target closed|element.*detached|waiting for locator/i,
    explain: (line) => `The target element/page was gone by the time the action ran (${line.trim()}).`,
  },
  {
    id: "resource-exhaustion",
    category: "resource",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "strong",
    pattern: /EMFILE|too many open files|ENOMEM|out of memory/i,
    explain: (line) => `The runner ran out of a shared resource (${line.trim()}).`,
  },
  {
    id: "db-contention",
    category: "concurrency",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "strong",
    pattern: /database is locked|deadlock detected|could not serialize access/i,
    explain: (line) => `Database-level lock contention was reported (${line.trim()}).`,
  },
  {
    id: "teardown-hang",
    category: "teardown",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "weak",
    pattern: /did not exit one second after the test run|did not exit cleanly|Force exiting Jest/i,
    explain: (line) => `This is a process-teardown warning, not a failed assertion (${line.trim()}).`,
  },
  {
    id: "unique-constraint-pollution",
    category: "test-pollution",
    verdict: "ENVIRONMENT_SIGNAL_DETECTED",
    matchStrength: "weak",
    pattern: /duplicate key value violates unique constraint|UNIQUE constraint failed/i,
    explain: (line) => `A uniqueness violation was reported (${line.trim()}).`,
  },
  {
    id: "wall-clock-sensitive",
    category: "time-sensitive",
    verdict: "UNVERIFIED",
    matchStrength: "weak",
    pattern: /RangeError: Invalid time value|toLocaleDateString|Invalid Date/i,
    explain: (line) =>
      `The failure touches date/time formatting (${line.trim()}). Could be a real bug or a test that isn't pinned to a fixed clock — a single run can't tell you which.`,
  },
];

// Appended once, uniformly, to every rule-based ENVIRONMENT_SIGNAL_DETECTED
// result — see the comment on RULES above for why this lives here and not
// inside each rule's explain(). Deliberately says "can occur for several
// reasons," not "this is caused by X": a connection reset, for instance, can
// originate from the application itself, an intermediary, or the network —
// the category label is a hint about what KIND of signature it is, not a
// claim about which of those actually happened.
function signalCaveat(category: string): string {
  return `This is a ${category} signature — it can occur for several different reasons, and the log alone does not establish which one, or whether the test is actually intermittent. Treat this as a lead to check, not a confirmed diagnosis.`;
}

function findEvidenceLine(rawText: string, pattern: RegExp): string {
  const line = rawText.split("\n").find((l) => pattern.test(l));
  return (line ?? rawText.slice(0, 160)).trim();
}

// A log can contain an environment signature AND a separate assertion
// mismatch (e.g. a connection reset on one line, a failed value comparison
// on another). Precedence picks which one drives the verdict, but the other
// observation must not be silently dropped — that would be exactly the kind
// of concealed evidence this tool exists to avoid. So when both are present,
// the assertion is surfaced as a second, explicit observation rather than
// discarded.
const ASSERTION_MARKER = /AssertionError|assert\s.+==|expect\(.+\)\.(to|toBe|toEqual|toContain)|expected .*(to equal|to be|,? got)/i;

function findCoOccurringAssertion(rawText: string, evidenceLine: string): string | null {
  const line = rawText.split("\n").find((l) => l.trim() !== evidenceLine && ASSERTION_MARKER.test(l));
  return line ? line.trim() : null;
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
      let explanation = rule.verdict === "ENVIRONMENT_SIGNAL_DETECTED" ? `${base} ${signalCaveat(rule.category)}` : base;
      if (rule.verdict === "ENVIRONMENT_SIGNAL_DETECTED") {
        const coOccurring = findCoOccurringAssertion(failure.rawText, evidenceLine);
        if (coOccurring) {
          explanation += ` Also present in this log, not discarded: an apparent assertion mismatch ("${coOccurring}") — the environment signature above does not rule this out as a separate or contributing issue.`;
        }
      }
      return {
        testName: failure.testName,
        framework: failure.framework,
        verdict: rule.verdict,
        confidence: rule.matchStrength,
        category: rule.category,
        ruleId: rule.id,
        evidenceLine,
        explanation,
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
      "No known failure signature matched. This log alone does not establish whether the failure is caused by a product defect, the test itself, or the environment. Rerun history and code review may provide additional evidence, though neither is guaranteed to resolve it.",
    source: "none",
  };
}
