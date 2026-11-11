import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFailures, parseLog } from "../src/parser.js";
import { classifyWithRules } from "../src/rules.js";

// Acceptance tests for docs/design/failure-evidence-boundaries.md, written BEFORE
// the extractors. Each one states a target from fixtures/real-excerpts/README.md.
//
// Each title names the step that made it pass, for example [step 3]. While a step
// was unfinished its tests were marked `todo`; the last marker went in step 7.

const EXCERPTS = "fixtures/real-excerpts";

function excerpt(name: string): string {
  return readFileSync(`${EXCERPTS}/${name}`, "utf8");
}

interface CliResult {
  verdict: string;
  ruleId?: string;
  abstainReason?: string;
}
interface CliOutput {
  results: CliResult[];
  unattributedSignals?: { ruleId: string }[];
}

// Runs the real CLI, so these tests check the output a user sees, not an internal API.
function cliJson(file: string): CliOutput {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "analyze", file, "--json"], {
    encoding: "utf8",
    env: { ...process.env, FLAKY_FINDER_API_KEY: "", FLAKY_FINDER_RULES_FILE: "" },
  });
  return JSON.parse(result.stdout) as CliOutput;
}

// ---- step 3: pytest extractor ----

test("[step 3] sentry: FLAKES creates no observation, and the postgres line after the summary is not failure evidence", () => {
  const failures = parseLog(excerpt("pytest-sentry-flakes-trailing-services.log"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].testName, "test_response_fields_are_described_and_typed");
  assert.ok(!failures[0].rawText.includes("duplicate key value"));
  assert.notEqual(classifyWithRules(failures[0]).ruleId, "unique-constraint-pollution");
});

test("[step 3] pytest collection error: short header found, phase collection, block ends before the generated xml line", () => {
  const failures = parseLog(excerpt("pytest-collection-error-short-header.log"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].extraction?.phase, "collection");
  assert.ok(!failures[0].rawText.includes("generated xml file"));
});

test("[step 3] pytest nested session: one outer failure, and the inner session's tests create no observations", () => {
  const failures = parseLog(excerpt("pytest-nested-session.log"));
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["test_failure_demo_fails_properly"],
  );
});

test("[step 3] pytest separators: `_ _ _ _` lines are not headers, and captured output is context, not primary evidence", () => {
  const failures = parseLog(excerpt("pytest-separators-captured-output.log"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].testName, "TestRequests.test_pyopenssl_redirect");
  assert.ok((failures[0].extraction?.contextSpans?.length ?? 0) > 0);
  assert.ok(!/Captured stdout call/.test(failures[0].rawText));
});

// ---- step 4: Jest extractor ----

test("[step 4] jest console under FAIL: `Console` is not a failure and is recorded as a diagnostic", () => {
  const { failures, diagnostics } = extractFailures(excerpt("jest-console-under-fail-then-pass.log"));
  assert.ok(failures.every((f) => f.framework === "jest" && !/^Console/.test(f.testName)));
  assert.ok(diagnostics.some((d) => d.code === "jest-console-block"));
});

test("[step 4] jest console under PASS: no Jest failure, and the block is a diagnostic", () => {
  const { failures, diagnostics } = extractFailures(excerpt("jest-console-under-pass.log"));
  assert.ok(failures.every((f) => f.framework !== "jest"));
  assert.ok(diagnostics.some((d) => d.code === "jest-console-block"));
});

test("[step 4] jest validation warning: warnings and indented nested output are not failures", () => {
  const failures = parseLog(excerpt("jest-validation-warning-nested-output.log"));
  assert.deepEqual(
    failures.map((f) => f.testName),
    ["formatting a mapped stack does not retain the environment"],
  );
});

// The spinner test below sits in step 4: the Jest extractor ignores spinner bullets
// (indented 6 or more spaces), so the log falls through to Playwright by then.
// ---- step 5: Playwright extractor ----

test("[step 5] playwright retries: 2 items, shell `124)` lines are not items, and the trailing ECONNRESET is not evidence", () => {
  const failures = parseLog(excerpt("playwright-retries-then-trailing-network-error.log"));
  assert.equal(failures.length, 2);
  assert.ok(failures[0].testName.includes("Instance AI background lifecycle"));
  assert.ok(failures[1].testName.includes("self-hosted onboarding"));
  assert.ok(failures.every((f) => !f.testName.includes("echo")));
  assert.ok((failures[0].extraction?.attempts?.length ?? 0) > 0);
  assert.ok(failures.every((f) => !f.rawText.includes("ECONNRESET")));
});

test("[step 4] playwright spinner: a log with Playwright items is not read as Jest", () => {
  const failures = parseLog(excerpt("playwright-spinner-bullets-and-items.log"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].framework, "playwright");
  assert.ok(failures[0].testName.includes("non translatable"));
});

// ---- step 6: merge, duplicates, unknown handling ----

test("[step 6] airflow: the reprinted FAILURES section gives 2 failures plus 2 merge diagnostics", () => {
  const { failures, diagnostics } = extractFailures(excerpt("pytest-repeated-failures-section.log"));
  assert.equal(failures.length, 2);
  assert.equal(diagnostics.filter((d) => d.code === "duplicate-failure-block").length, 2);
});

test("[step 6] grafana: the summary repeat of a Jest failure is merged into one failure", () => {
  const { failures, diagnostics } = extractFailures(excerpt("jest-console-under-fail-then-pass.log"));
  assert.equal(failures.length, 1);
  assert.ok(diagnostics.some((d) => d.code === "duplicate-failure-block"));
});

test("[step 6] playwright load failure: boundary unknown, and no test name is invented", () => {
  const [failure] = parseLog(excerpt("playwright-load-failure.log"));
  assert.equal(failure.extraction?.boundary, "unknown");
  assert.equal(failure.framework, "generic");
  assert.equal(failure.testName, "unrecognized-log-format");
});

for (const name of ["unknown-format-shell-script.log", "unknown-format-signal-among-passing-tests.log"]) {
  test(`[step 6] ${name}: an unknown format log is one observation with boundary unknown`, () => {
    const failures = parseLog(excerpt(name));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].framework, "generic");
    assert.equal(failures[0].extraction?.boundary, "unknown");
  });
}

// ---- step 7: eligibility and output. These run the real CLI. ----

test("[step 7] sentry: no environment verdict, and the postgres line is a top level unattributed signal", () => {
  const out = cliJson(`${EXCERPTS}/pytest-sentry-flakes-trailing-services.log`);
  assert.ok(out.results.every((r) => r.verdict !== "ENVIRONMENT_SIGNAL_DETECTED"));
  assert.ok(out.unattributedSignals?.some((s) => s.ruleId === "unique-constraint-pollution"));
});

test("[step 7] n8n: the ECONNRESET after the count lines decides no verdict and is an unattributed signal", () => {
  const out = cliJson(`${EXCERPTS}/playwright-retries-then-trailing-network-error.log`);
  assert.ok(out.results.every((r) => r.ruleId !== "network-reset"));
  assert.ok(out.unattributedSignals?.some((s) => s.ruleId === "network-reset"));
});

for (const [name, ruleId] of [
  ["unknown-format-shell-script.log", "resource-exhaustion"],
  ["unknown-format-signal-among-passing-tests.log", "network-reset"],
] as const) {
  test(`[step 7] ${name}: UNVERIFIED with boundary-unknown, and the match is an unattributed signal`, () => {
    const out = cliJson(`${EXCERPTS}/${name}`);
    assert.equal(out.results[0].verdict, "UNVERIFIED");
    assert.equal(out.results[0].abstainReason, "boundary-unknown");
    assert.ok(out.unattributedSignals?.some((s) => s.ruleId === ruleId));
  });
}

// Paired with "classifyWithRules on text with no extraction data..." in rules.test.ts:
// that test keeps the old behaviour for text with no log position. This one covers
// text that DID come from extraction and whose block never ended. There is no real
// excerpt for it (the design lists it as a case needing a small made-up input).
test("[step 7] a failure block cut off before any end marker gets no verdict, even though its signal survived", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-finder-truncated-"));
  try {
    const file = join(dir, "truncated.log");
    writeFileSync(
      file,
      [
        "=================================== FAILURES ===================================",
        "_______________________________ test_checkout _______________________________",
        "",
        "E       requests.exceptions.ConnectionError: Connection reset by peer",
        "",
      ].join("\n"),
    );
    const out = cliJson(file);
    assert.equal(out.results[0].verdict, "UNVERIFIED");
    assert.equal(out.results[0].abstainReason, "boundary-truncated");
    assert.ok(out.unattributedSignals?.some((s) => s.ruleId === "network-reset"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
