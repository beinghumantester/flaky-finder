import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openHistoryDb, DEFAULT_HISTORY_DB_PATH } from "./history-db.js";
import { ingestJUnitReport, JUnitParseError } from "./history-ingest.js";
import { listTrackedTestIds, summarizeTest, reportAll } from "./history-analysis.js";
import type { TestSummary } from "./history-types.js";

const ASSESSMENT_ICON: Record<TestSummary["assessment"], string> = {
  INTERMITTENCY_OBSERVED: "🟠",
  FAILURE_REPEATED: "🔴",
  INSUFFICIENT_HISTORY: "⚪",
  PASS_ONLY: "🟢",
};

const USAGE = `Usage: flaky-finder history <ingest|show|report> ...
  flaky-finder history ingest <junit-report.xml> [--commit <sha>] [--run-id <id>] [--environment <id>] [--framework <name>] [--db <path>] [--json]
  flaky-finder history show <test-name-or-id> [--db <path>] [--json]
  flaky-finder history report [--framework <name>] [--db <path>] [--json]`;

// Same schema version as the analyze command's --json output (cli.ts).
const JSON_SCHEMA_VERSION = 1;

interface ParsedArgs {
  positional: string[];
  flags: {
    db?: string;
    commit?: string;
    "run-id"?: string;
    environment?: string;
    framework?: string;
    results?: string;
    json: boolean;
    help: boolean;
  };
}

// node:util's parseArgs, strict: an unknown or misspelled flag (e.g.
// --comit) is an error, not silently ignored — silently dropping --commit
// would record runs without the commit SHA that INTERMITTENCY_OBSERVED
// depends on.
function parseHistoryArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      commit: { type: "string" },
      "run-id": { type: "string" },
      environment: { type: "string" },
      framework: { type: "string" },
      results: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return { positional: positionals, flags: values };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...(value as object) }, null, 2));
}

function printSummary(summary: TestSummary): void {
  console.log(`${ASSESSMENT_ICON[summary.assessment]} ${summary.assessment}`);
  console.log(`   test: ${summary.testName}  (${summary.testId})`);
  console.log(
    `   runs: ${summary.totalRuns} total — ${summary.counts.PASSED} passed, ${summary.counts.FAILED} failed, ${summary.counts.SKIPPED} skipped, across ${summary.distinctCommits} distinct commit(s)`,
  );
  console.log(`   first seen: ${summary.firstSeen}  last seen: ${summary.lastSeen}`);
  console.log(`   what this means: ${summary.assessmentExplanation}`);
  if (summary.recentRuns.length > 0) {
    console.log("   recent runs (most recent first):");
    for (const run of summary.recentRuns) {
      const commit = run.commitSha ? run.commitSha.slice(0, 12) : "(no commit recorded)";
      const signature = run.ruleId ? ` [${run.ruleId}: ${run.evidenceLine ?? ""}]` : "";
      console.log(`     - ${run.recordedAt}  ${run.outcome}  run=${run.runId}  commit=${commit}${signature}`);
    }
  }
  console.log("");
}

function runIngest(args: ParsedArgs): void {
  const file = args.flags.results ?? args.positional[0];
  if (!file) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const dbPath = args.flags.db ?? DEFAULT_HISTORY_DB_PATH;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`Could not read ${file}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const db = openHistoryDb(dbPath);
  try {
    const result = ingestJUnitReport(db, file, raw, {
      commitSha: args.flags.commit,
      runId: args.flags["run-id"],
      environmentId: args.flags.environment,
      framework: args.flags.framework,
    });

    if (args.flags.json) {
      printJson({ db: dbPath, file, ...result });
      return;
    }

    if (result.skipped) {
      console.log(
        `Duplicate report: this exact content was already ingested as ingestion #${result.existingIngestionId} at ${result.existingIngestedAt} — skipped, nothing recorded twice.`,
      );
      return;
    }

    console.log(
      `Ingested ${file}: ${result.totalCases} test case(s) — ${result.counts.PASSED} passed, ${result.counts.FAILED} failed, ${result.counts.SKIPPED} skipped.`,
    );
    console.log(
      `  run: ${result.runId}  commit: ${result.commitSha ?? "(none recorded)"}  framework: ${result.framework}  db: ${dbPath}`,
    );
    if (result.warnings.length > 0) {
      console.log("  warnings:");
      for (const warning of result.warnings) console.log(`    - ${warning}`);
    }
  } catch (err) {
    if (err instanceof JUnitParseError) {
      console.error(`Could not parse ${file} as a JUnit XML report: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    db.close();
  }
}

function runShow(args: ParsedArgs): void {
  const query = args.positional[0];
  if (!query) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const dbPath = args.flags.db ?? DEFAULT_HISTORY_DB_PATH;
  const db = openHistoryDb(dbPath);
  try {
    const exact = summarizeTest(db, query);
    if (args.flags.json) {
      const tests = exact
        ? [exact]
        : listTrackedTestIds(db, { nameQuery: query })
            .map((testId) => summarizeTest(db, testId))
            .filter((summary): summary is TestSummary => summary !== null);
      printJson({ db: dbPath, query, tests });
      return;
    }
    if (exact) {
      printSummary(exact);
      return;
    }

    const matches = listTrackedTestIds(db, { nameQuery: query });
    if (matches.length === 0) {
      console.log(
        `No history found for "${query}". Run "flaky-finder history ingest <junit-report.xml>" to start collecting it.`,
      );
      return;
    }
    if (matches.length > 1) {
      console.log(
        `"${query}" matches ${matches.length} distinct tracked tests — showing all of them. Pass the full test id (shown below) to disambiguate next time.`,
      );
      console.log("");
    }
    for (const testId of matches) {
      const summary = summarizeTest(db, testId);
      if (summary) printSummary(summary);
    }
  } finally {
    db.close();
  }
}

function runReport(args: ParsedArgs): void {
  const dbPath = args.flags.db ?? DEFAULT_HISTORY_DB_PATH;
  const db = openHistoryDb(dbPath);
  try {
    const summaries = reportAll(db, { framework: args.flags.framework });
    if (args.flags.json) {
      const summary: Record<TestSummary["assessment"], number> = {
        INTERMITTENCY_OBSERVED: 0,
        FAILURE_REPEATED: 0,
        INSUFFICIENT_HISTORY: 0,
        PASS_ONLY: 0,
      };
      for (const s of summaries) summary[s.assessment] += 1;
      printJson({ db: dbPath, tests: summaries, summary });
      return;
    }
    if (summaries.length === 0) {
      console.log(
        `No history recorded yet in ${dbPath}. Run "flaky-finder history ingest <junit-report.xml>" to start collecting it.`,
      );
      return;
    }
    for (const summary of summaries) printSummary(summary);

    const totals = summaries.reduce(
      (acc, s) => ({ ...acc, [s.assessment]: (acc[s.assessment] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    console.log("Summary:", totals);
  } finally {
    db.close();
  }
}

export function runHistoryCommand(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    (subcommand === undefined ? console.error : console.log)(USAGE);
    if (subcommand === undefined) process.exitCode = 2;
    return;
  }

  let args: ParsedArgs;
  try {
    args = parseHistoryArgs(rest);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.flags.help) {
    console.log(USAGE);
    return;
  }

  switch (subcommand) {
    case "ingest":
      runIngest(args);
      return;
    case "show":
      runShow(args);
      return;
    case "report":
      runReport(args);
      return;
    default:
      console.error(`Unknown history command "${subcommand}".\n\n${USAGE}`);
      process.exitCode = 2;
  }
}
