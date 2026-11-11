// Historical tracking is a SEPARATE axis from the single-log verdicts in
// types.ts. A test keeps its log-level verdict (ENVIRONMENT_SIGNAL_DETECTED /
// SUSPECTED_REGRESSION / UNVERIFIED) AND gets an independent historical
// assessment from the data below. Never conflate the two: the verdict
// describes what one log shows; the assessment describes what the recorded
// run history shows. See README's "Historical tracking" section for what
// each assessment does and doesn't establish.

/** What actually happened when a test ran, from a JUnit XML report — not inferred from a failure verdict. */
export type TestOutcome = "PASSED" | "FAILED" | "SKIPPED" | "UNKNOWN";

/**
 * - INSUFFICIENT_HISTORY — fewer than two non-skipped runs are recorded, OR
 *   the recorded runs are mixed (some passed, some failed) but never on the
 *   SAME commit, so there's no same-commit pass/fail pattern to point to.
 *   This is the conservative default: it covers "not enough data" and
 *   "the data we have doesn't support a stronger claim," not just the first.
 * - FAILURE_REPEATED — every non-skipped recorded run failed. Root cause is
 *   still unknown; this is not evidence of a product defect, only of
 *   consistency across the runs we happened to record.
 * - PASS_ONLY — every non-skipped recorded run passed. This does not prove
 *   the test can never fail — it means no failure has been recorded yet.
 * - INTERMITTENCY_OBSERVED — the same test passed AND failed on the SAME
 *   commit SHA across recorded runs. This is real evidence of intermittent
 *   outcomes. It still does NOT establish a root cause, and does not rule
 *   out environment or infrastructure differences between those runs.
 */
export type HistoryAssessment = "INTERMITTENCY_OBSERVED" | "FAILURE_REPEATED" | "PASS_ONLY" | "INSUFFICIENT_HISTORY";

/** One recorded execution of one test, as stored in test_runs. */
export interface TestRunRow {
  id: number;
  testId: string;
  testName: string;
  classname: string | null;
  framework: string;
  outcome: TestOutcome;
  runId: string;
  commitSha: string | null;
  environmentId: string | null;
  recordedAt: string;
}

/** Failure-specific detail for a FAILED test_runs row, kept in its own table on purpose (see rules.ts RULESET_VERSION). */
export interface FailureEvidenceRow {
  testRunId: number;
  verdict: string | null;
  ruleId: string | null;
  rulesetVersion: number | null;
  evidenceLine: string | null;
  explanation: string | null;
}

export interface IngestSkipped {
  skipped: true;
  reason: "duplicate";
  /** id of the ingestion this report's content was already recorded under. */
  existingIngestionId: number;
  existingIngestedAt: string;
}

export interface IngestCompleted {
  skipped: false;
  ingestionId: number;
  runId: string;
  commitSha: string | null;
  environmentId: string | null;
  framework: string;
  totalCases: number;
  counts: Record<TestOutcome, number>;
  /** Non-fatal issues (e.g. a <testcase> missing a name attribute, skipped rather than guessed). */
  warnings: string[];
}

export type IngestResult = IngestSkipped | IngestCompleted;

export interface TestSummary {
  testId: string;
  testName: string;
  classname: string | null;
  framework: string;
  totalRuns: number;
  counts: Record<TestOutcome, number>;
  distinctCommits: number;
  firstSeen: string;
  lastSeen: string;
  assessment: HistoryAssessment;
  assessmentExplanation: string;
  recentRuns: Array<{
    runId: string;
    commitSha: string | null;
    outcome: TestOutcome;
    recordedAt: string;
    ruleId: string | null;
    evidenceLine: string | null;
  }>;
}
