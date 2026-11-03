import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end: runs the real CLI in a child process, so argument parsing,
// exit codes and stdout shape are tested exactly as a CI step would see them.
function cli(...args: string[]) {
  return cliWithEnv({}, ...args);
}

function cliWithEnv(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, FLAKY_FINDER_API_KEY: "", FLAKY_FINDER_RULES_FILE: "", ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--version prints the package.json version", () => {
  const { code, stdout } = cli("--version");
  assert.equal(code, 0);
  assert.equal(stdout.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);
});

test("--help prints usage and exits 0; no arguments prints usage and exits 2", () => {
  assert.match(cli("--help").stdout, /flaky-finder analyze <ci-log-file>/);
  assert.equal(cli("--help").code, 0);
  const none = cli();
  assert.equal(none.code, 2);
  assert.match(none.stderr, /No command given/);
});

test("an unknown flag is a usage error (exit 2), not silently ignored", () => {
  const { code, stderr } = cli("analyze", "fixtures/pytest-sample.log", "--jsn");
  assert.equal(code, 2);
  assert.match(stderr, /Unknown option '--jsn'/);
});

test("analyze --json prints exactly one parseable JSON object with a zero-filled summary", () => {
  const { code, stdout } = cli("analyze", "fixtures/pytest-sample.log", "--json");
  assert.equal(code, 0);
  const output = JSON.parse(stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.results.length, 2);
  assert.equal(output.results[0].ruleId, "network-reset");
  assert.deepEqual(output.summary, { ENVIRONMENT_SIGNAL_DETECTED: 1, SUSPECTED_REGRESSION: 0, UNVERIFIED: 1 });
  assert.equal(output.customRules, null);
});

test("a bare file argument still works the same as `analyze`", () => {
  const bare = cli("fixtures/jest-sample.log", "--json");
  const explicit = cli("analyze", "fixtures/jest-sample.log", "--json");
  assert.deepEqual(JSON.parse(bare.stdout).results, JSON.parse(explicit.stdout).results);
});

test("FLAKY_FINDER_RULES_FILE loads custom rules, and a bad rules file exits 1 with the reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-finder-cli-"));
  try {
    const good = join(dir, "rules.json");
    writeFileSync(
      good,
      JSON.stringify({
        rules: [
          {
            id: "team-api-reset",
            category: "network",
            verdict: "ENVIRONMENT_SIGNAL_DETECTED",
            matchStrength: "exact",
            pattern: "Connection reset by peer",
          },
        ],
      }),
    );
    const output = JSON.parse(
      cliWithEnv({ FLAKY_FINDER_RULES_FILE: good }, "analyze", "fixtures/pytest-sample.log", "--json").stdout,
    );
    assert.deepEqual(output.customRules, { path: good, count: 1 });
    assert.equal(output.results[0].ruleId, "team-api-reset");
    assert.equal(output.results[0].ruleOrigin, "custom");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ rules: [{ id: "x", verdict: "SUSPECTED_REGRESSION" }] }));
    const failed = cliWithEnv({ FLAKY_FINDER_RULES_FILE: bad }, "analyze", "fixtures/pytest-sample.log");
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /rules\[0\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing log file exits 1 with a readable message", () => {
  const { code, stderr } = cli("analyze", "does-not-exist.log");
  assert.equal(code, 1);
  assert.match(stderr, /Could not read does-not-exist\.log/);
});

test("history ingest/show/report --json round-trip through a throwaway database", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-finder-cli-"));
  const db = join(dir, "history.db");
  try {
    const ingest = JSON.parse(
      cli("history", "ingest", "fixtures/junit-sample.xml", "--commit", "c1", "--run-id", "r1", "--db", db, "--json")
        .stdout,
    );
    assert.equal(ingest.schemaVersion, 1);
    assert.equal(ingest.skipped, false);

    const show = JSON.parse(cli("history", "show", "test_fetch_user_retries", "--db", db, "--json").stdout);
    assert.equal(show.tests.length, 1);
    assert.equal(show.tests[0].assessment, "INSUFFICIENT_HISTORY");

    const report = JSON.parse(cli("history", "report", "--db", db, "--json").stdout);
    assert.equal(report.tests.length, ingest.totalCases);
    assert.equal(Object.keys(report.summary).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyze groups repeated rule matches, excludes weak rules by default, and never touches the ungrouped results", () => {
  const defaultRun = JSON.parse(cli("analyze", "fixtures/pytest-grouping-sample.log", "--json").stdout);
  assert.equal(defaultRun.results.length, 6, "all 6 failures still present, ungrouped, regardless of grouping");

  // 3 ECONNRESET failures (exact) — one repeated test name — form a group.
  // 2 teardown-hang failures (weak) do not, by default.
  assert.equal(defaultRun.failureGroups.length, 1);
  const [group] = defaultRun.failureGroups;
  assert.equal(group.groupingMethod, "rule_id");
  assert.equal(group.ruleId, "network-reset");
  assert.equal(group.ruleOrigin, "builtin");
  assert.equal(group.matchStrength, "exact");
  assert.equal(group.occurrenceCount, 3);
  assert.equal(group.affectedTestCount, 3, "three distinct test names in this fixture");
  assert.match(group.limitation, /not a confirmed shared root cause/);
  assert.equal(group.observations.length, 3);
  // Grouping is read-only: an observation is the exact same object shape as
  // its entry in the top-level, ungrouped results array.
  assert.deepEqual(
    group.observations.find((o: { testName: string }) => o.testName === "test_checkout_flow"),
    defaultRun.results.find((r: { testName: string }) => r.testName === "test_checkout_flow"),
  );

  const weakRun = JSON.parse(
    cli("analyze", "fixtures/pytest-grouping-sample.log", "--include-weak-groups", "--json").stdout,
  );
  assert.equal(weakRun.failureGroups.length, 2, "teardown-hang now also forms a group");
  const teardownGroup = weakRun.failureGroups.find((g: { ruleId: string }) => g.ruleId === "teardown-hang");
  assert.equal(teardownGroup.matchStrength, "weak");
  assert.equal(teardownGroup.occurrenceCount, 2);
});

test("the text output's failure signature section is omitted when nothing repeats, and shown with the limitation sentence when it does", () => {
  const noGroups = cli("analyze", "fixtures/pytest-sample.log");
  assert.doesNotMatch(noGroups.stdout, /Failure signature groups/);

  const withGroups = cli("analyze", "fixtures/pytest-grouping-sample.log");
  assert.match(withGroups.stdout, /Failure signature groups/);
  assert.match(withGroups.stdout, /3x network-reset/);
  assert.match(withGroups.stdout, /not a confirmed shared root cause/);
});

test("a misspelled history flag is rejected instead of silently recording a run without it", () => {
  const { code, stderr } = cli("history", "ingest", "fixtures/junit-sample.xml", "--comit", "abc");
  assert.equal(code, 2);
  assert.match(stderr, /Unknown option '--comit'/);
});

// Contract tests for docs/json-output.md. If one of these fails, either the
// change was accidental, or it's intentional and needs the doc updated —
// and, if a field was removed or changed meaning, a schemaVersion bump.
function keys(value: object): string[] {
  return Object.keys(value).sort();
}

test("JSON contract: analyze output keeps its documented fields", () => {
  const output = JSON.parse(cli("analyze", "fixtures/pytest-sample.log", "--json").stdout);
  assert.deepEqual(keys(output), [
    "customRules",
    "failureGroups",
    "input",
    "llmFallback",
    "results",
    "schemaVersion",
    "summary",
    "tool",
  ]);
  const [ruleResult, noneResult] = output.results;
  assert.deepEqual(keys(ruleResult), [
    "alsoMatched",
    "category",
    "confidence",
    "evidenceLine",
    "explanation",
    "framework",
    "ruleId",
    "ruleOrigin",
    "source",
    "testName",
    "verdict",
  ]);
  assert.deepEqual(keys(noneResult), ["confidence", "explanation", "framework", "source", "testName", "verdict"]);
});

test("JSON contract: history ingest/show/report keep their documented fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-finder-cli-"));
  const db = join(dir, "history.db");
  const ingestArgs = ["history", "ingest", "fixtures/junit-sample.xml", "--run-id", "r1", "--db", db, "--json"];
  try {
    assert.deepEqual(keys(JSON.parse(cli(...ingestArgs).stdout)), [
      "commitSha",
      "counts",
      "db",
      "environmentId",
      "file",
      "framework",
      "ingestionId",
      "runId",
      "schemaVersion",
      "skipped",
      "totalCases",
      "warnings",
    ]);
    assert.deepEqual(keys(JSON.parse(cli(...ingestArgs).stdout)), [
      "db",
      "existingIngestedAt",
      "existingIngestionId",
      "file",
      "reason",
      "schemaVersion",
      "skipped",
    ]);

    const show = JSON.parse(cli("history", "show", "test_fetch_user_retries", "--db", db, "--json").stdout);
    assert.deepEqual(keys(show), ["db", "query", "schemaVersion", "tests"]);
    assert.deepEqual(keys(show.tests[0]), [
      "assessment",
      "assessmentExplanation",
      "classname",
      "counts",
      "distinctCommits",
      "firstSeen",
      "framework",
      "lastSeen",
      "recentRuns",
      "testId",
      "testName",
      "totalRuns",
    ]);
    assert.deepEqual(keys(show.tests[0].recentRuns[0]), [
      "commitSha",
      "evidenceLine",
      "outcome",
      "recordedAt",
      "ruleId",
      "runId",
    ]);

    const report = JSON.parse(cli("history", "report", "--db", db, "--json").stdout);
    assert.deepEqual(keys(report), ["db", "schemaVersion", "summary", "tests"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json writes only JSON to stdout; warnings and errors go to stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-finder-cli-"));
  try {
    // On Node versions where node:sqlite prints an ExperimentalWarning, it
    // must land on stderr, never inside the JSON on stdout.
    const { stdout } = cli("history", "report", "--db", join(dir, "h.db"), "--json");
    assert.doesNotThrow(() => JSON.parse(stdout));
    assert.doesNotMatch(stdout, /Warning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
