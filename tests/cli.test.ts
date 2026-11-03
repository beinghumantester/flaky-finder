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

test("a misspelled history flag is rejected instead of silently recording a run without it", () => {
  const { code, stderr } = cli("history", "ingest", "fixtures/junit-sample.xml", "--comit", "abc");
  assert.equal(code, 2);
  assert.match(stderr, /Unknown option '--comit'/);
});
