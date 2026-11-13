import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeLog } from "../src/analyze-log.js";

// Every log-like fixture, so the shared entry point is checked on the same
// inputs the CLI tests and the evaluation use, including unknown formats.
function fixtureFiles(): string[] {
  const dirs = ["fixtures", "fixtures/real-excerpts"];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".log") || name.endsWith(".xml"))
      .map((name) => join(dir, name)),
  );
}

function cliJson(file: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "analyze", file, "--json", ...flags], {
    encoding: "utf8",
    env: { ...process.env, FLAKY_FINDER_API_KEY: "", FLAKY_FINDER_RULES_FILE: "" },
  });
  assert.equal(result.status, 0, `CLI failed on ${file}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("the CLI's --json analysis fields are exactly what analyzeLog() returns, for every fixture", async () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 15, `expected the full fixture set, found ${files.length}`);
  for (const file of files) {
    for (const includeWeakGroups of [false, true]) {
      const analysis = await analyzeLog(readFileSync(file, "utf8"), { includeWeakGroups });
      const cli = cliJson(file, ...(includeWeakGroups ? ["--include-weak-groups"] : []));
      const label = `${file} (includeWeakGroups=${includeWeakGroups})`;
      assert.deepEqual(cli.results, analysis.results, `results differ: ${label}`);
      assert.deepEqual(cli.failureGroups, analysis.failureGroups, `failureGroups differ: ${label}`);
      assert.deepEqual(cli.summary, analysis.summary, `summary differs: ${label}`);
      assert.deepEqual(cli.unattributedSignals, analysis.unattributedSignals, `unattributedSignals differ: ${label}`);
      assert.deepEqual(cli.diagnostics, analysis.diagnostics, `diagnostics differ: ${label}`);
      assert.equal(analysis.failureCount, analysis.results.length, `failureCount != results.length: ${label}`);
    }
  }
});

test("analyzeLog() never writes to stdout or stderr", async (t) => {
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  for (const file of fixtureFiles()) await analyzeLog(readFileSync(file, "utf8"));
  const out = stdout.mock.callCount();
  const err = stderr.mock.callCount();
  stdout.mock.restore();
  stderr.mock.restore();
  assert.equal(out, 0, "analyzeLog wrote to stdout");
  assert.equal(err, 0, "analyzeLog wrote to stderr");
});

test("analyzeLog() on empty input keeps the existing behaviour: one unknown-format UNVERIFIED observation", async () => {
  // Pins current behaviour (same as the CLI on an empty file); this refactor must not change it.
  const analysis = await analyzeLog("");
  assert.equal(analysis.failureCount, 1);
  assert.equal(analysis.results[0].testName, "unrecognized-log-format");
  assert.equal(analysis.results[0].abstainReason, "boundary-unknown");
  assert.deepEqual(analysis.summary, { ENVIRONMENT_SIGNAL_DETECTED: 0, SUSPECTED_REGRESSION: 0, UNVERIFIED: 1 });
});

test("analyzeLog() is rules-only unless a classifier is passed", async () => {
  let calls = 0;
  const raw = readFileSync("fixtures/pytest-sample.log", "utf8");
  await analyzeLog(raw);
  const withLlm = await analyzeLog(raw, {
    llm: async () => {
      calls += 1;
      return { kind: "unavailable", detail: "test stub" };
    },
  });
  assert.ok(calls > 0, "the classifier passed in was never called");
  assert.ok(
    withLlm.results.some((r) => r.abstainReason === "llm-unavailable"),
    "a failing classifier should leave an llm-unavailable result",
  );
});
