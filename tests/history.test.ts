import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDb, SCHEMA_VERSION } from "../src/history-db.js";
import { ingestJUnitReport, buildTestId, JUnitParseError } from "../src/history-ingest.js";
import { assessHistory, summarizeTest, listTrackedTestIds, reportAll } from "../src/history-analysis.js";
import { parseJUnitXml, JUnitParseError as JUnitParseErrorFromParser } from "../src/junit-parser.js";

function freshDb(): DatabaseSync {
  return openHistoryDb(":memory:");
}

function junit(cases: string): string {
  return `<?xml version="1.0"?><testsuite name="suite" tests="1">${cases}</testsuite>`;
}

function passCase(classname: string, name: string): string {
  return `<testcase classname="${classname}" name="${name}" time="0.01" />`;
}

function failCase(classname: string, name: string, message: string, body = ""): string {
  return `<testcase classname="${classname}" name="${name}" time="0.01"><failure message="${message}">${body}</failure></testcase>`;
}

function skipCase(classname: string, name: string): string {
  return `<testcase classname="${classname}" name="${name}" time="0.0"><skipped message="skipped"/></testcase>`;
}

// --- Milestone 1/2: storage + ingestion basics ---------------------------

test("ingesting a JUnit report records one test_runs row per test case, with correct outcomes", () => {
  const db = freshDb();
  const raw = junit(passCase("pkg.mod", "test_a") + failCase("pkg.mod", "test_b", "boom", "ECONNRESET: socket hang up"));
  const result = ingestJUnitReport(db, "report.xml", raw, { commitSha: "c1", runId: "r1", framework: "pytest" });
  assert.equal(result.skipped, false);
  if (result.skipped) throw new Error("unreachable");
  assert.equal(result.totalCases, 2);
  assert.deepEqual(result.counts, { PASSED: 1, FAILED: 1, SKIPPED: 0, UNKNOWN: 0 });

  const summary = summarizeTest(db, buildTestId("pytest", "pkg.mod", "test_b"));
  assert.ok(summary);
  assert.equal(summary!.counts.FAILED, 1);
  assert.equal(summary!.recentRuns[0].ruleId, "network-reset", "a failed case's text should be classified by the existing rule engine during ingestion");
});

test("duplicate ingestion: re-ingesting byte-identical report content is detected and skipped, not double counted", () => {
  const db = freshDb();
  const raw = junit(passCase("pkg.mod", "test_a"));
  const first = ingestJUnitReport(db, "report.xml", raw, { commitSha: "c1", runId: "r1" });
  assert.equal(first.skipped, false);

  const second = ingestJUnitReport(db, "report.xml", raw, { commitSha: "c1", runId: "r1" });
  assert.equal(second.skipped, true);
  if (!second.skipped) throw new Error("unreachable");
  assert.equal(second.reason, "duplicate");

  const summary = summarizeTest(db, buildTestId("generic", "pkg.mod", "test_a"));
  assert.equal(summary!.totalRuns, 1, "a duplicate ingestion must not create a second row for the same test");
});

test("a malformed (non-JUnit) report throws a clear JUnitParseError instead of silently ingesting nothing", () => {
  const db = freshDb();
  assert.throws(() => ingestJUnitReport(db, "not-xml.txt", "this is plain text, not a report"), JUnitParseError);
});

test("a <testcase> missing its name attribute is skipped with a warning, not invented", () => {
  const raw = junit(`<testcase classname="pkg" time="0.01" />` + passCase("pkg", "test_real"));
  const { cases, warnings } = parseJUnitXml(raw);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].name, "test_real");
  assert.equal(warnings.length, 1);
});

test("a failed test case with no failure detail text records that limitation instead of guessing a signature", () => {
  const db = freshDb();
  const raw = junit(`<testcase classname="pkg" name="test_x" time="0.01"><failure message=""></failure></testcase>`);
  ingestJUnitReport(db, "report.xml", raw, { runId: "r1" });
  const summary = summarizeTest(db, buildTestId("generic", "pkg", "test_x"));
  assert.equal(summary!.recentRuns[0].ruleId, null);
});

test("JUnitParseError is thrown by the parser itself on input with no <testsuite> or <testcase> at all", () => {
  assert.throws(() => parseJUnitXml("<html><body>not a report</body></html>"), JUnitParseErrorFromParser);
});

test("a skipped test case is recorded as SKIPPED through the real ingest -> summarize path, and doesn't count as a pass or fail", () => {
  const db = freshDb();
  ingestJUnitReport(db, "report.xml", junit(skipCase("pkg", "test_not_ready")), { runId: "r1", commitSha: "c1" });
  const summary = summarizeTest(db, buildTestId("generic", "pkg", "test_not_ready"));
  assert.ok(summary);
  assert.deepEqual(summary!.counts, { PASSED: 0, FAILED: 0, SKIPPED: 1, UNKNOWN: 0 });
  assert.equal(summary!.assessment, "INSUFFICIENT_HISTORY", "a single skipped run is neither a pass nor a fail, so this is not PASS_ONLY");
  assert.equal(summary!.recentRuns[0].outcome, "SKIPPED");
});

// --- Milestone 3: historical analysis / assessHistory ---------------------

test("incomplete history: a single recorded run is INSUFFICIENT_HISTORY, never a stronger claim", () => {
  const result = assessHistory([{ outcome: "FAILED", commitSha: "c1" }]);
  assert.equal(result.assessment, "INSUFFICIENT_HISTORY");
});

test("zero recorded runs is INSUFFICIENT_HISTORY", () => {
  assert.equal(assessHistory([]).assessment, "INSUFFICIENT_HISTORY");
});

test("every recorded run failing is FAILURE_REPEATED", () => {
  const result = assessHistory([
    { outcome: "FAILED", commitSha: "c1" },
    { outcome: "FAILED", commitSha: "c2" },
    { outcome: "FAILED", commitSha: "c3" },
  ]);
  assert.equal(result.assessment, "FAILURE_REPEATED");
});

test("every recorded run passing is PASS_ONLY", () => {
  const result = assessHistory([
    { outcome: "PASSED", commitSha: "c1" },
    { outcome: "PASSED", commitSha: "c2" },
  ]);
  assert.equal(result.assessment, "PASS_ONLY");
});

test("same commit, pass and fail both recorded, is INTERMITTENCY_OBSERVED", () => {
  const result = assessHistory([
    { outcome: "FAILED", commitSha: "c1" },
    { outcome: "PASSED", commitSha: "c1" },
  ]);
  assert.equal(result.assessment, "INTERMITTENCY_OBSERVED");
});

test("changed commits: failing on one commit then passing on a DIFFERENT commit is NOT intermittency — could be a genuine fix", () => {
  const result = assessHistory([
    { outcome: "FAILED", commitSha: "c1" },
    { outcome: "PASSED", commitSha: "c2" },
  ]);
  assert.notEqual(result.assessment, "INTERMITTENCY_OBSERVED", "a fix between commits must not be reported as flakiness evidence");
  assert.equal(result.assessment, "INSUFFICIENT_HISTORY");
});

test("changed commits: across three commits, failing then passing then failing again on three DIFFERENT commits is still not same-commit intermittency", () => {
  const result = assessHistory([
    { outcome: "FAILED", commitSha: "c1" },
    { outcome: "PASSED", commitSha: "c2" },
    { outcome: "FAILED", commitSha: "c3" },
  ]);
  assert.equal(result.assessment, "INSUFFICIENT_HISTORY");
});

test("two runs with no commit_sha recorded at all are never treated as 'the same commit' — unrecorded is not evidence of sameness", () => {
  const result = assessHistory([
    { outcome: "FAILED", commitSha: null },
    { outcome: "PASSED", commitSha: null },
  ]);
  assert.notEqual(
    result.assessment,
    "INTERMITTENCY_OBSERVED",
    "two runs with no commit recorded don't establish 'same code' — this must not be upgraded to intermittency evidence"
  );
  assert.equal(result.assessment, "INSUFFICIENT_HISTORY");
});

// --- "ambiguous test identities" ------------------------------------------

test("ambiguous test identities: two genuinely different tests sharing a name are kept distinct when their classnames differ", () => {
  const idA = buildTestId("pytest", "tests.module_a", "test_shared_name");
  const idB = buildTestId("pytest", "tests.module_b", "test_shared_name");
  assert.notEqual(idA, idB, "different classnames must not collide into one test identity");
});

test("ambiguous test identities: two different tests that both omit classname DO collide into the same identity — a documented limitation, not a crash", () => {
  const db = freshDb();
  // Same name, no classname, ingested as two separate failures with
  // DIFFERENT evidence — representing two unrelated tests that happen to
  // share a bare name in a report that didn't record classnames.
  const run1 = junit(failCase("", "test_shared", "net", "ECONNRESET: socket hang up"));
  const run2 = junit(failCase("", "test_shared", "db", "database is locked"));
  ingestJUnitReport(db, "a.xml", run1, { runId: "r1", commitSha: "c1" });
  ingestJUnitReport(db, "b.xml", run2, { runId: "r2", commitSha: "c2" });

  const testId = buildTestId("generic", null, "test_shared");
  const summary = summarizeTest(db, testId);
  assert.ok(summary, "both ingestions must land under the same merged identity when classname is absent for both");
  assert.equal(summary!.totalRuns, 2, "history for two unrelated tests gets merged under this limitation — by design, not a bug, and must be documented");
});

test("history show's ambiguity handling: a name query matching multiple distinct test_ids lists all of them rather than guessing one", () => {
  const db = freshDb();
  ingestJUnitReport(db, "a.xml", junit(passCase("suite.one", "test_login")), { runId: "r1" });
  ingestJUnitReport(db, "b.xml", junit(passCase("suite.two", "test_login")), { runId: "r2" });
  const matches = listTrackedTestIds(db, { nameQuery: "test_login" });
  assert.equal(matches.length, 2, "distinct classnames must produce two separate, listed matches rather than one tool silently picking one");
});

// --- per-test summaries / report ------------------------------------------

// --- Regression tests from external code review -------------------------

test("Finding 1: two separate runs with byte-identical content but DIFFERENT run ids are both recorded, not treated as a duplicate", () => {
  const db = freshDb();
  const raw = junit(passCase("pkg", "test_a"));
  const runA = ingestJUnitReport(db, "a.xml", raw, { runId: "run-A", commitSha: "c1" });
  const runB = ingestJUnitReport(db, "b.xml", raw, { runId: "run-B", commitSha: "c1" });
  assert.equal(runA.skipped, false, "the first legitimate run must be recorded");
  assert.equal(runB.skipped, false, "a second legitimate run with identical content but a different run_id must NOT be discarded as a duplicate");

  const summary = summarizeTest(db, buildTestId("generic", "pkg", "test_a"));
  assert.equal(summary!.totalRuns, 2, "both runs must be present in history");
});

test("Finding 1: re-ingesting the same content under the SAME run id is still correctly treated as a duplicate", () => {
  const db = freshDb();
  const raw = junit(passCase("pkg", "test_a"));
  const first = ingestJUnitReport(db, "a.xml", raw, { runId: "run-A", commitSha: "c1" });
  const second = ingestJUnitReport(db, "a.xml", raw, { runId: "run-A", commitSha: "c1" });
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true, "same run_id + same content is a retry of the same ingestion, not a new run");
});

test("Finding 2: foreign-key constraints are actually enforced, not just declared", () => {
  const db = freshDb();
  assert.throws(
    () => db.prepare("INSERT INTO failure_evidence (test_run_id, verdict, rule_id, ruleset_version, evidence_line, explanation) VALUES (?, ?, ?, ?, ?, ?)").run(999999, "UNVERIFIED", null, null, null, null),
    /FOREIGN KEY/i,
    "inserting failure_evidence against a test_run_id that doesn't exist must be rejected, not silently create an orphan row"
  );
});

test("Finding 3: assessHistory filters SKIPPED/UNKNOWN points itself, not just via the caller's pre-filtering", () => {
  // Without internal filtering, the SKIPPED point would make `every(outcome === "FAILED")`
  // false and incorrectly fall through to INSUFFICIENT_HISTORY, even though
  // the two real (non-skipped) data points are both FAILED.
  const result = assessHistory([
    { outcome: "FAILED", commitSha: "c1" },
    { outcome: "FAILED", commitSha: "c1" },
    { outcome: "SKIPPED" as any, commitSha: "c1" },
  ]);
  assert.equal(result.assessment, "FAILURE_REPEATED", "a SKIPPED point passed directly to assessHistory must not corrupt the result");
});

test("Finding 4a: an out-of-range numeric XML entity does not crash the parser", () => {
  const raw = junit(failCase("pkg", "test_x", "bad entity", "value &#1114112; is out of Unicode range"));
  assert.doesNotThrow(() => parseJUnitXml(raw));
  const { cases } = parseJUnitXml(raw);
  assert.match(cases[0].detail ?? "", /&#1114112;/, "an entity that can't be decoded must fall back to the literal text, not disappear or crash");
});

test("Finding 4b: a testcase with BOTH <failure> and <error> elements uses only the first and warns about the rest", () => {
  const raw = junit(`<testcase classname="pkg" name="test_dual" time="0.1"><failure message="first">first detail</failure><error message="second">second detail</error></testcase>`);
  const { cases, warnings } = parseJUnitXml(raw);
  assert.equal(cases[0].status, "FAILED");
  assert.match(cases[0].detail ?? "", /first detail/);
  assert.doesNotMatch(cases[0].detail ?? "", /second detail/);
  assert.ok(warnings.some((w) => /2 <failure>\/<error>/.test(w)), "must warn that a second failure/error element was not surfaced");
});

test("Finding 4c: a truncated <testcase> (no closing tag, cut off mid-report) is excluded with a warning, not silently miscounted", () => {
  const raw = `<testsuite name="s">${passCase("pkg", "test_complete")}<testcase classname="pkg" name="test_truncated" time="0.1">`;
  const { cases, warnings } = parseJUnitXml(raw);
  assert.equal(cases.length, 1, "only the well-formed case should be returned");
  assert.ok(warnings.some((w) => /truncated or malformed/.test(w)), "the truncated tag must be flagged, not silently dropped");
});

test("Finding 4d: a report using XML namespaces (<ns:testsuite>/<ns:testcase>) is not silently misread as zero tests — it fails loudly instead", () => {
  const raw = `<ns:testsuite xmlns:ns="urn:example"><ns:testcase name="test_a"/></ns:testsuite>`;
  assert.throws(() => parseJUnitXml(raw), JUnitParseErrorFromParser, "a namespaced report isn't recognized by this parser — documented limitation, surfaced as a clear error");
});

test("Finding 4e: duplicate <testcase> entries (same name+classname) within one report are preserved as separate cases, not collapsed", () => {
  const raw = junit(failCase("pkg", "test_retry", "first try", "ECONNRESET") + passCase("pkg", "test_retry"));
  const { cases } = parseJUnitXml(raw);
  const matching = cases.filter((c) => c.name === "test_retry");
  assert.equal(matching.length, 2, "a report with the same test listed twice (e.g. a rerun plugin) must produce two distinct case entries, not one");
  assert.equal(matching[0].status, "FAILED");
  assert.equal(matching[1].status, "PASSED");
});

test("transaction safety: a malformed report that fails to parse writes nothing at all — no partial ingestion row, no partial test_runs rows", () => {
  const db = freshDb();
  assert.throws(() => ingestJUnitReport(db, "bad.xml", "not xml at all"), JUnitParseError);
  const ingestionCount = (db.prepare("SELECT COUNT(*) as n FROM ingestions").get() as { n: number }).n;
  const runCount = (db.prepare("SELECT COUNT(*) as n FROM test_runs").get() as { n: number }).n;
  assert.equal(ingestionCount, 0, "a parse failure happens before any write begins — nothing should be recorded");
  assert.equal(runCount, 0);
});

test("openHistoryDb stamps a fresh database with the current SCHEMA_VERSION, and refuses to open one stamped with a different version", () => {
  const path = join(tmpdir(), `ff-history-version-test-${process.pid}-${Date.now()}.db`);
  try {
    const db1 = openHistoryDb(path);
    assert.equal((db1.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    db1.close();

    // Simulate a database written by some OTHER schema version (future or
    // otherwise) — openHistoryDb must refuse it rather than silently read
    // or write it as if the schema matched.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 999;");
    raw.close();

    assert.throws(() => openHistoryDb(path), /schema version 999/);
  } finally {
    rmSync(path, { force: true });
  }
});

test("transaction safety (integration): ingestJUnitReport itself rolls back every row from a failed ingestion, via a real SQLite error — not a reimplemented transaction", () => {
  // Earlier version of this test manually re-implemented BEGIN/COMMIT/
  // ROLLBACK, which proved SQLite's transaction behavior but not that
  // ingestJUnitReport's own try/catch actually triggers on a real failure.
  // This one forces an actual failure INSIDE the real function via a
  // trigger that aborts when a specific sentinel test name is inserted —
  // no special test hook added to the application itself.
  const db = freshDb();
  db.exec(`
    CREATE TRIGGER test_only_abort_on_poison
    AFTER INSERT ON test_runs
    WHEN NEW.test_name = '__poison__'
    BEGIN
      SELECT RAISE(ABORT, 'simulated failure for integration rollback test');
    END;
  `);

  const raw = junit(passCase("pkg", "test_ok") + passCase("pkg", "__poison__"));
  assert.throws(() => ingestJUnitReport(db, "report.xml", raw, { runId: "r1", commitSha: "c1" }), /simulated failure for integration rollback test/);

  const ingestionCount = (db.prepare("SELECT COUNT(*) as n FROM ingestions").get() as { n: number }).n;
  const runCount = (db.prepare("SELECT COUNT(*) as n FROM test_runs").get() as { n: number }).n;
  const evidenceCount = (db.prepare("SELECT COUNT(*) as n FROM failure_evidence").get() as { n: number }).n;
  assert.equal(ingestionCount, 0, "the ingestion row must be rolled back");
  assert.equal(runCount, 0, "test_ok's row — inserted successfully BEFORE the poisoned row — must be rolled back too, not left committed");
  assert.equal(evidenceCount, 0);
});

test("transaction safety (lower-level): a write that fails partway through an ingestion rolls back EVERY row from that ingestion, including earlier successful writes in the same transaction", () => {
  // Kept as a lower-level complement to the integration test above: this
  // one exercises the exact BEGIN/COMMIT-or-ROLLBACK pattern directly
  // against the real schema and a real connection, with a deliberately
  // invalid second write (the CHECK constraint on test_runs.outcome)
  // standing in for "any write fails here."
  const db = freshDb();
  const insertIngestion = db.prepare(
    "INSERT INTO ingestions (report_hash, run_id, commit_sha, environment_id, framework, source_file, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertRun = db.prepare(
    "INSERT INTO test_runs (ingestion_id, test_id, test_name, classname, framework, outcome, run_id, commit_sha, environment_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  assert.throws(() => {
    db.exec("BEGIN");
    try {
      const info = insertIngestion.run("hash1", "run1", null, null, "generic", "f.xml", "2026-01-01T00:00:00Z");
      const ingestionId = Number(info.lastInsertRowid);
      // This first row is entirely valid and would succeed on its own.
      insertRun.run(ingestionId, "id1", "test_ok", null, "generic", "PASSED", "run1", null, null, "2026-01-01T00:00:00Z");
      // This second row violates the CHECK(outcome IN (...)) constraint.
      insertRun.run(ingestionId, "id2", "test_bad", null, "generic", "BOGUS", "run1", null, null, "2026-01-01T00:00:00Z");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }, /CHECK constraint failed/i);

  const ingestionCount = (db.prepare("SELECT COUNT(*) as n FROM ingestions").get() as { n: number }).n;
  const runCount = (db.prepare("SELECT COUNT(*) as n FROM test_runs").get() as { n: number }).n;
  assert.equal(ingestionCount, 0, "the ingestion row must be rolled back even though its own INSERT succeeded");
  assert.equal(runCount, 0, "the earlier VALID test_runs row (test_ok) must also be rolled back — it was part of the same failed transaction, not committed separately");
});

test("reportAll surfaces INTERMITTENCY_OBSERVED and FAILURE_REPEATED ahead of PASS_ONLY", () => {
  const db = freshDb();
  ingestJUnitReport(db, "a.xml", junit(passCase("s", "test_ok") + passCase("s", "test_ok")), { runId: "r1", commitSha: "c1" });
  // second run for test_ok to make it PASS_ONLY with 2 runs
  ingestJUnitReport(db, "b.xml", junit(passCase("s", "test_ok")), { runId: "r2", commitSha: "c1" });
  ingestJUnitReport(db, "c.xml", junit(failCase("s", "test_flaky", "x", "ECONNRESET")), { runId: "r3", commitSha: "c2" });
  ingestJUnitReport(db, "d.xml", junit(passCase("s", "test_flaky")), { runId: "r4", commitSha: "c2" });

  const summaries = reportAll(db);
  assert.equal(summaries[0].testName, "test_flaky");
  assert.equal(summaries[0].assessment, "INTERMITTENCY_OBSERVED");
});
