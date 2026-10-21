import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseJUnitXml, JUnitParseError } from "./junit-parser.js";
import { classifyWithRules, RULESET_VERSION } from "./rules.js";
import type { IngestResult, TestOutcome } from "./history-types.js";

export { JUnitParseError };

export interface IngestOptions {
  runId?: string;
  commitSha?: string;
  environmentId?: string;
  framework?: string;
}

/**
 * Builds the composite identity history is tracked under. JUnit XML's only
 * reliable fields are classname + name, so that's what identity is built
 * from — NOT a guarantee of uniqueness. Two genuinely different tests that
 * share both a classname and a name (most commonly: a report that omits
 * classname entirely for every test) will be recorded as the SAME test_id,
 * merging their history. This is a documented limitation, not a bug — see
 * README's "Historical tracking" section and tests/history.test.ts's
 * "ambiguous test identities" case, which pins down exactly this behavior.
 */
export function buildTestId(framework: string, classname: string | null, name: string): string {
  const classPart = classname && classname.trim().length > 0 ? classname.trim() : "(no-classname)";
  return `${framework}::${classPart}::${name}`;
}

function emptyCounts(): Record<TestOutcome, number> {
  return { PASSED: 0, FAILED: 0, SKIPPED: 0, UNKNOWN: 0 };
}

/**
 * Ingests one JUnit XML report into the history database. Idempotent on
 * (run_id, exact file content): re-ingesting byte-identical input under the
 * SAME run_id is detected and skipped rather than double counted — see
 * tests/history.test.ts's "duplicate ingestion" case. Deliberately NOT
 * deduplicated on content alone: two separate, legitimate runs that happen
 * to produce byte-identical reports (e.g. two consecutive all-pass runs on
 * the same commit) must both be recorded as long as they're given
 * different run_ids — only a repeat of the SAME run_id is treated as a
 * retry of the same ingestion. Omitting --run-id defaults to a timestamp,
 * so every such ingestion is treated as new (no dedup protection without a
 * stable id to dedup against).
 */
export function ingestJUnitReport(db: DatabaseSync, sourceFile: string, raw: string, options: IngestOptions = {}): IngestResult {
  const reportHash = createHash("sha256").update(raw).digest("hex");
  const runId = options.runId ?? `run-${Date.now()}`;

  // Scoped to (runId, reportHash), not reportHash alone — see the comment on
  // the ingestions table in history-db.ts. Two different runs with
  // identical content must both be recorded; only a repeat of the SAME run
  // (same run_id) with the same content is a duplicate.
  const existing = db.prepare("SELECT id, ingested_at FROM ingestions WHERE run_id = ? AND report_hash = ?").get(runId, reportHash) as
    | { id: number; ingested_at: string }
    | undefined;
  if (existing) {
    return { skipped: true, reason: "duplicate", existingIngestionId: existing.id, existingIngestedAt: existing.ingested_at };
  }

  const { cases, warnings } = parseJUnitXml(raw);
  if (cases.length === 0) {
    throw new JUnitParseError(`No usable <testcase> elements found in ${sourceFile}.`);
  }

  const framework = options.framework ?? "generic";
  const commitSha = options.commitSha ?? null;
  const environmentId = options.environmentId ?? null;
  const ingestedAt = new Date().toISOString();

  const insertIngestion = db.prepare(
    "INSERT INTO ingestions (report_hash, run_id, commit_sha, environment_id, framework, source_file, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertRun = db.prepare(
    "INSERT INTO test_runs (ingestion_id, test_id, test_name, classname, framework, outcome, run_id, commit_sha, environment_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertEvidence = db.prepare(
    "INSERT INTO failure_evidence (test_run_id, verdict, rule_id, ruleset_version, evidence_line, explanation) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const counts = emptyCounts();
  let ingestionId: number;

  // One report's worth of inserts (the ingestion row, every test_runs row,
  // every failure_evidence row) must land as a single unit — a crash or
  // thrown error partway through (e.g. a future bug, a constraint violation
  // on some row N of M) must not leave a report half-recorded, which would
  // silently corrupt every later historical assessment for the tests in it.
  // node:sqlite's DatabaseSync has no transaction() helper (unlike
  // better-sqlite3), so this is a manual BEGIN/COMMIT/ROLLBACK.
  db.exec("BEGIN");
  try {
    const ingestionInfo = insertIngestion.run(reportHash, runId, commitSha, environmentId, framework, sourceFile, ingestedAt);
    ingestionId = Number(ingestionInfo.lastInsertRowid);

    for (const testCase of cases) {
      const testId = buildTestId(framework, testCase.classname, testCase.name);
      const runInfo = insertRun.run(
        ingestionId,
        testId,
        testCase.name,
        testCase.classname,
        framework,
        testCase.status,
        runId,
        commitSha,
        environmentId,
        ingestedAt
      );
      counts[testCase.status] += 1;

      if (testCase.status !== "FAILED") continue;
      const testRunId = Number(runInfo.lastInsertRowid);

      if (!testCase.detail) {
        // Failed, but the report carried no failure detail at all — record
        // that honestly instead of inventing a signature or silently skipping it.
        insertEvidence.run(
          testRunId,
          null,
          null,
          null,
          null,
          "No failure detail was present in the report for this test — the signature engine needs error text, and this report didn't include any."
        );
        continue;
      }

      const result = classifyWithRules({ testName: testCase.name, framework: "generic", rawText: testCase.detail });
      insertEvidence.run(
        testRunId,
        result.verdict,
        result.ruleId ?? null,
        result.source === "rule" ? RULESET_VERSION : null,
        result.evidenceLine ?? null,
        result.explanation
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return {
    skipped: false,
    ingestionId,
    runId,
    commitSha,
    environmentId,
    framework,
    totalCases: cases.length,
    counts,
    warnings,
  };
}
