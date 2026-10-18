import type { Rule, Failure, AnalysisResult } from "./types.js";

// Every rule fires on a SPECIFIC, well-known flaky-test signature — never on a bare
// assertion mismatch. A rule that fired on "expected 1 to equal 2" would just be
// guessing with extra steps. Ordered roughly by how unambiguous the signature is.
export const RULES: Rule[] = [
  {
    id: "network-reset",
    category: "network",
    verdict: "LIKELY_FLAKY",
    confidence: "high",
    pattern: /ECONNRESET|Connection reset by peer|socket hang up/i,
    explain: (line) =>
      `The connection was reset mid-request (${line.trim()}). This is almost always an environment/network blip, not a code defect.`,
  },
  {
    id: "port-in-use",
    category: "resource",
    verdict: "LIKELY_FLAKY",
    confidence: "high",
    pattern: /EADDRINUSE|address already in use/i,
    explain: (line) =>
      `A previous process on the runner hadn't released the port yet (${line.trim()}). Classic parallel-CI-job collision, not a logic bug.`,
  },
  {
    id: "stale-dom-element",
    category: "ui-timing",
    verdict: "LIKELY_FLAKY",
    confidence: "high",
    pattern: /stale element reference|Element is not attached to the DOM/i,
    explain: (line) =>
      `The DOM node was replaced between lookup and interaction (${line.trim()}). Standard UI-test timing race, not a product bug.`,
  },
  {
    id: "dns-resolution",
    category: "network",
    verdict: "LIKELY_FLAKY",
    confidence: "medium",
    pattern: /ENOTFOUND|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)/i,
    explain: (line) =>
      `DNS resolution failed (${line.trim()}). Usually a transient resolver hiccup on the CI runner.`,
  },
  {
    id: "timeout-exceeded",
    category: "timing",
    verdict: "LIKELY_FLAKY",
    confidence: "medium",
    pattern: /ETIMEDOUT|Test timeout of \d+ms exceeded|Timed out retrying/i,
    explain: (line) =>
      `The test hit a timeout rather than a wrong value (${line.trim()}). Worth checking for a tight timeout before assuming a real regression.`,
  },
  {
    id: "locator-target-closed",
    category: "ui-timing",
    verdict: "LIKELY_FLAKY",
    confidence: "medium",
    pattern: /Target closed|element.*detached|waiting for locator/i,
    explain: (line) =>
      `The target element/page was gone by the time the action ran (${line.trim()}). Common async-rendering race in browser tests.`,
  },
  {
    id: "resource-exhaustion",
    category: "resource",
    verdict: "LIKELY_FLAKY",
    confidence: "medium",
    pattern: /EMFILE|too many open files|ENOMEM|out of memory/i,
    explain: (line) =>
      `The runner ran out of a shared resource (${line.trim()}), not something the test's own logic controls.`,
  },
  {
    id: "db-contention",
    category: "concurrency",
    verdict: "LIKELY_FLAKY",
    confidence: "medium",
    pattern: /database is locked|deadlock detected|could not serialize access/i,
    explain: (line) =>
      `Database-level lock contention (${line.trim()}). Points at parallel test execution, not the assertion itself.`,
  },
  {
    id: "teardown-hang",
    category: "teardown",
    verdict: "LIKELY_FLAKY",
    confidence: "low",
    pattern: /did not exit one second after the test run|did not exit cleanly|Force exiting Jest/i,
    explain: (line) =>
      `This is a process-teardown warning (${line.trim()}), not a failed assertion — usually a dangling handle (timer, socket) rather than wrong behavior.`,
  },
  {
    id: "unique-constraint-pollution",
    category: "test-pollution",
    verdict: "LIKELY_FLAKY",
    confidence: "low",
    pattern: /duplicate key value violates unique constraint|UNIQUE constraint failed/i,
    explain: (line) =>
      `A uniqueness violation (${line.trim()}) this far into a test run is frequently leftover state from a prior test, not bad logic in this one — but that needs confirming, not assuming.`,
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

function findEvidenceLine(rawText: string, pattern: RegExp): string {
  const line = rawText.split("\n").find((l) => pattern.test(l));
  return (line ?? rawText.slice(0, 160)).trim();
}

/**
 * Pure, deterministic, auditable classification. No model call, no guessing:
 * a failure that matches no known signature is UNVERIFIED, never rounded up
 * to LIKELY_REAL_BUG or down to LIKELY_FLAKY.
 */
export function classifyWithRules(failure: Failure): AnalysisResult {
  for (const rule of RULES) {
    if (rule.pattern.test(failure.rawText)) {
      const evidenceLine = findEvidenceLine(failure.rawText, rule.pattern);
      return {
        testName: failure.testName,
        framework: failure.framework,
        verdict: rule.verdict,
        confidence: rule.confidence,
        category: rule.category,
        ruleId: rule.id,
        evidenceLine,
        explanation: rule.explain(evidenceLine),
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
      "No known flaky signature matched. A plain assertion mismatch from a single run can't honestly be called a real bug OR flaky — that needs a rerun-history check or code review.",
    source: "none",
  };
}
