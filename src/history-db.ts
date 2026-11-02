import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// node:sqlite is experimental as of Node 22 (prints an ExperimentalWarning to
// stderr — expected, harmless). Picked over a third-party driver so history
// tracking adds zero new dependencies: this project's whole pitch is being
// small enough to read in one sitting, and a local SQLite file is exactly
// the "no server, no account" shape that fits a CLI. Requires Node >=22.5.
export const DEFAULT_HISTORY_DB_PATH = ".flaky-finder/history.db";

// Bump this whenever SCHEMA below changes in a way existing databases need
// to be migrated for, and add the actual migration step at that point —
// there is exactly one schema version so far (this one has never shipped:
// an earlier, uncommitted draft of this file briefly had
// UNIQUE(report_hash) alone, caught and fixed in review before any release,
// so there is no real database anywhere with that old constraint to
// migrate FROM). This constant plus the user_version check in
// openHistoryDb below is the hook the next real migration will need; it's
// deliberately not a migration FRAMEWORK, since there's nothing to migrate
// yet.
export const SCHEMA_VERSION = 1;

const SCHEMA = `
-- UNIQUE is on (run_id, report_hash), NOT report_hash alone. report_hash
-- alone would treat two genuinely separate, legitimate CI runs that happen
-- to produce byte-identical JUnit XML (e.g. same commit, same all-pass
-- result) as "the same ingestion" and silently discard the second one —
-- that's a real loss of history, not just a harmless skip. Scoping the
-- uniqueness to (run_id, report_hash) instead makes the actual contract:
-- "ingesting the exact same content under the SAME run_id again is treated
-- as a safe-to-retry duplicate of that one ingestion call." Two different
-- run_ids are always two different executions, no matter what their content
-- hashes to. Callers that want duplicate protection must pass a stable
-- --run-id; omitting it (the CLI defaults to a timestamp) means every
-- ingestion is treated as new, which is the honest answer when there's no
-- stable identifier to deduplicate against.
CREATE TABLE IF NOT EXISTS ingestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  commit_sha TEXT,
  environment_id TEXT,
  framework TEXT NOT NULL,
  source_file TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE(run_id, report_hash)
);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingestion_id INTEGER NOT NULL REFERENCES ingestions(id),
  test_id TEXT NOT NULL,
  test_name TEXT NOT NULL,
  classname TEXT,
  framework TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
  run_id TEXT NOT NULL,
  commit_sha TEXT,
  environment_id TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_runs_test_id ON test_runs(test_id);

-- Kept as its own table, not extra columns on test_runs: a rule-based
-- signature is a statement about the LOG TEXT, not about the test outcome
-- itself, and keeping it separate means a later ruleset change can never be
-- mistaken for a change in recorded pass/fail behavior. See rules.ts's
-- RULESET_VERSION.
CREATE TABLE IF NOT EXISTS failure_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_run_id INTEGER NOT NULL REFERENCES test_runs(id),
  verdict TEXT,
  rule_id TEXT,
  ruleset_version INTEGER,
  evidence_line TEXT,
  explanation TEXT
);
CREATE INDEX IF NOT EXISTS idx_failure_evidence_test_run_id ON failure_evidence(test_run_id);
`;

export function openHistoryDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // Off by default in SQLite — without this, the REFERENCES declarations
  // above are documentation only and orphaned rows are silently possible
  // (e.g. a failure_evidence row whose test_run_id was never actually
  // inserted). Must be set per-connection, every time one is opened.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  // PRAGMA user_version defaults to 0 on a database that's never set it.
  // 0 here means "created by this version of the tool, never stamped yet"
  // (true for every database today, since SCHEMA_VERSION 1 is the first
  // one ever shipped) — stamp it. A nonzero value that doesn't match means
  // this database was written by a DIFFERENT schema version: refuse rather
  // than silently reading/writing it as if it matched, which is exactly
  // the bug a future schema change could otherwise reintroduce.
  const { user_version: currentVersion } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (currentVersion === 0) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  } else if (currentVersion !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${path}: schema version ${currentVersion} does not match this build's version ${SCHEMA_VERSION}. A migration step is needed here once a real schema change ships — none exists yet because none has been needed yet.`
    );
  }

  return db;
}
