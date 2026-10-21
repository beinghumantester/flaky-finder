import type { DatabaseSync } from "node:sqlite";
import type { HistoryAssessment, TestOutcome, TestSummary } from "./history-types.js";

export interface HistoryPoint {
  outcome: TestOutcome;
  commitSha: string | null;
}

export interface AssessmentResult {
  assessment: HistoryAssessment;
  explanation: string;
}

const EXPLANATIONS: Record<HistoryAssessment, string> = {
  INSUFFICIENT_HISTORY:
    "The recorded history does not support a reliable conclusion — either too few runs are recorded, or the runs are mixed (some passed, some failed) but never on the same commit, so there's no same-commit pass/fail pattern to point to. A fix between commits can look identical to this from the data alone.",
  FAILURE_REPEATED:
    "Every recorded run of this test failed. This is consistency across the runs we happened to record, not proof of a product defect — the root cause is still unestablished, and nothing here rules out an environment issue that's simply present on every run recorded so far.",
  PASS_ONLY:
    "Every recorded run of this test passed. This does not prove the test can never fail — it means no failure has been recorded in the history collected so far.",
  INTERMITTENCY_OBSERVED:
    "The same test both passed and failed on the SAME commit across recorded runs. That is real evidence of intermittent outcomes under comparable code — but it does not establish a root cause, and does not rule out environment or infrastructure differences between those specific runs.",
};

/**
 * Pure decision logic over a test's recorded run history — no DB access, so
 * every branch is directly unit-testable (see tests/history.test.ts).
 * SKIPPED runs are excluded before any of this logic runs: a skip is neither
 * a pass nor a fail, and counting it as either would misrepresent the
 * history.
 */
export function assessHistory(points: HistoryPoint[]): AssessmentResult {
  // Enforced here, not just by the caller: a SKIPPED or UNKNOWN point is
  // neither a pass nor a fail, and every branch below assumes only PASSED/
  // FAILED remain. summarizeTest already filters before calling this, but
  // this function is exported and must not silently misclassify history if
  // some other caller passes an unfiltered list.
  const nonSkipped = points.filter((p) => p.outcome === "PASSED" || p.outcome === "FAILED");
  if (nonSkipped.length < 2) {
    return { assessment: "INSUFFICIENT_HISTORY", explanation: EXPLANATIONS.INSUFFICIENT_HISTORY };
  }

  // A null commitSha means "not recorded," not "same commit as every other
  // unrecorded run" — grouping two unknown-commit points together would let
  // this claim INTERMITTENCY_OBSERVED from evidence that never actually
  // established "same code." So each unrecorded-commit point gets its own
  // bucket and can never combine with another to produce that assessment.
  let unknownCommitCounter = 0;
  const byCommit = new Map<string, Set<TestOutcome>>();
  for (const point of nonSkipped) {
    const key = point.commitSha ?? `\u0000unknown-${unknownCommitCounter++}`;
    const set = byCommit.get(key) ?? new Set<TestOutcome>();
    set.add(point.outcome);
    byCommit.set(key, set);
  }
  for (const outcomes of byCommit.values()) {
    if (outcomes.has("PASSED") && outcomes.has("FAILED")) {
      return { assessment: "INTERMITTENCY_OBSERVED", explanation: EXPLANATIONS.INTERMITTENCY_OBSERVED };
    }
  }

  if (nonSkipped.every((p) => p.outcome === "FAILED")) {
    return { assessment: "FAILURE_REPEATED", explanation: EXPLANATIONS.FAILURE_REPEATED };
  }
  if (nonSkipped.every((p) => p.outcome === "PASSED")) {
    return { assessment: "PASS_ONLY", explanation: EXPLANATIONS.PASS_ONLY };
  }

  // Mixed PASSED/FAILED, but never on the same commit (e.g. failed on commit
  // A, passed on commit B) — could be a genuine fix, not intermittency.
  // Deliberately NOT a new category: the roadmap commits to exactly four
  // assessments, and this case doesn't meet the bar for any of the other
  // three, so it stays at the most conservative one.
  return { assessment: "INSUFFICIENT_HISTORY", explanation: EXPLANATIONS.INSUFFICIENT_HISTORY };
}

interface TestRunQueryRow {
  test_name: string;
  classname: string | null;
  framework: string;
  outcome: TestOutcome;
  run_id: string;
  commit_sha: string | null;
  recorded_at: string;
  rule_id: string | null;
  evidence_line: string | null;
}

function fetchRunsForTestId(db: DatabaseSync, testId: string): TestRunQueryRow[] {
  return db
    .prepare(
      `SELECT tr.test_name, tr.classname, tr.framework, tr.outcome, tr.run_id, tr.commit_sha, tr.recorded_at,
              fe.rule_id, fe.evidence_line
       FROM test_runs tr
       LEFT JOIN failure_evidence fe ON fe.test_run_id = tr.id
       WHERE tr.test_id = ?
       ORDER BY tr.recorded_at ASC, tr.id ASC`
    )
    .all(testId) as unknown as TestRunQueryRow[];
}

/** Every distinct test_id currently tracked, optionally narrowed by framework or a case-insensitive substring match on the test name. */
export function listTrackedTestIds(db: DatabaseSync, filters: { framework?: string; nameQuery?: string } = {}): string[] {
  const rows = db.prepare("SELECT DISTINCT test_id, test_name, framework FROM test_runs").all() as unknown as Array<{
    test_id: string;
    test_name: string;
    framework: string;
  }>;
  return rows
    .filter((r) => !filters.framework || r.framework === filters.framework)
    .filter((r) => !filters.nameQuery || r.test_name.toLowerCase().includes(filters.nameQuery.toLowerCase()) || r.test_id.toLowerCase().includes(filters.nameQuery.toLowerCase()))
    .map((r) => r.test_id);
}

const RECENT_RUNS_LIMIT = 10;

export function summarizeTest(db: DatabaseSync, testId: string): TestSummary | null {
  const rows = fetchRunsForTestId(db, testId);
  if (rows.length === 0) return null;

  const counts: Record<TestOutcome, number> = { PASSED: 0, FAILED: 0, SKIPPED: 0, UNKNOWN: 0 };
  const commits = new Set<string>();
  for (const row of rows) {
    counts[row.outcome] += 1;
    if (row.commit_sha) commits.add(row.commit_sha);
  }

  const historyPoints = rows.filter((r) => r.outcome === "PASSED" || r.outcome === "FAILED").map((r) => ({ outcome: r.outcome, commitSha: r.commit_sha }));
  const { assessment, explanation } = assessHistory(historyPoints);

  const recentRuns = rows
    .slice(-RECENT_RUNS_LIMIT)
    .reverse()
    .map((r) => ({
      runId: r.run_id,
      commitSha: r.commit_sha,
      outcome: r.outcome,
      recordedAt: r.recorded_at,
      ruleId: r.rule_id,
      evidenceLine: r.evidence_line,
    }));

  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    testId,
    testName: last.test_name,
    classname: last.classname,
    framework: last.framework,
    totalRuns: rows.length,
    counts,
    distinctCommits: commits.size,
    firstSeen: first.recorded_at,
    lastSeen: last.recorded_at,
    assessment,
    assessmentExplanation: explanation,
    recentRuns,
  };
}

export function reportAll(db: DatabaseSync, filters: { framework?: string } = {}): TestSummary[] {
  const testIds = listTrackedTestIds(db, filters);
  const summaries = testIds.map((id) => summarizeTest(db, id)).filter((s): s is TestSummary => s !== null);
  // Surface the assessments most worth a human's attention first.
  const priority: Record<HistoryAssessment, number> = { INTERMITTENCY_OBSERVED: 0, FAILURE_REPEATED: 1, INSUFFICIENT_HISTORY: 2, PASS_ONLY: 3 };
  return summaries.sort((a, b) => priority[a.assessment] - priority[b.assessment] || a.testId.localeCompare(b.testId));
}
