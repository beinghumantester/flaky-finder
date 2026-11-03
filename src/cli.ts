#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseLog } from "./parser.js";
import { classifyWithRules } from "./rules.js";
import { classifyWithLlm, hasLlmFallback } from "./llm.js";
import { CustomRuleError, loadCustomRules } from "./custom-rules.js";
import type { AnalysisResult, Rule, Verdict } from "./types.js";

// Bump when a field is removed or changes meaning in --json output. Adding a
// new field doesn't need a bump — consumers should ignore fields they don't
// know.
export const JSON_SCHEMA_VERSION = 1;

const VERDICT_ICON: Record<AnalysisResult["verdict"], string> = {
  ENVIRONMENT_SIGNAL_DETECTED: "🟡",
  SUSPECTED_REGRESSION: "🔴",
  UNVERIFIED: "⚪",
};

const USAGE = `Usage:
  flaky-finder analyze <ci-log-file> [--json]
  flaky-finder <ci-log-file> [--json]            (same as analyze)
  flaky-finder history <ingest|show|report> ...  (see: flaky-finder history --help)
  flaky-finder --help | --version

analyze options:
  --json   Print one JSON object to stdout instead of human-readable text

Environment:
  FLAKY_FINDER_RULES_FILE   Path to a JSON file of custom rules, checked before the built-ins (analyze only)
  FLAKY_FINDER_API_KEY      Enables the optional LLM fallback for failures no rule matches`;

function readVersion(): string {
  // Resolves to the package root from both src/ (tsx) and dist/ (built).
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

async function runAnalyze(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    usageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) usageError("Expected exactly one <ci-log-file>.");
  const file = positionals[0];

  const rulesFile = process.env.FLAKY_FINDER_RULES_FILE || undefined;
  let customRules: Rule[] = [];
  if (rulesFile) {
    try {
      customRules = loadCustomRules(rulesFile);
    } catch (err) {
      if (err instanceof CustomRuleError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`Could not read ${file}: ${(err as Error).message}`);
    process.exit(1);
  }

  const failures = parseLog(raw);
  const results: AnalysisResult[] = [];
  for (const failure of failures) {
    let result = classifyWithRules(failure, customRules);
    if (result.source === "none" && hasLlmFallback()) {
      result = await classifyWithLlm(failure);
    }
    results.push(result);
  }

  // Every verdict is always present (zero-filled), so a consumer never has
  // to treat a missing key as zero.
  const summary: Record<Verdict, number> = { ENVIRONMENT_SIGNAL_DETECTED: 0, SUSPECTED_REGRESSION: 0, UNVERIFIED: 0 };
  for (const r of results) summary[r.verdict] += 1;

  if (values.json) {
    const output = {
      schemaVersion: JSON_SCHEMA_VERSION,
      tool: { name: "flaky-finder", version: readVersion() },
      input: file,
      llmFallback: hasLlmFallback(),
      customRules: rulesFile ? { path: rulesFile, count: customRules.length } : null,
      results,
      summary,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Parsed ${failures.length} failure(s) from ${file}`);
  if (rulesFile) console.log(`Custom rules: ${customRules.length} loaded from ${rulesFile} (checked before built-ins)`);
  console.log(hasLlmFallback() ? "LLM fallback: enabled\n" : "LLM fallback: disabled (rules-only mode)\n");

  for (const r of results) {
    // Rule matches are plain string/regex presence — there's no statistical
    // score behind them, so the display never calls that "confidence"
    // (exact/strong/weak match-strength instead). Only the LLM step, which
    // self-reports an actual confidence in its own classification, uses
    // that word.
    const strengthOrConfidence =
      r.source === "rule" ? `signature-match: ${r.confidence}` : `${r.confidence} verdict confidence`;
    const via = r.ruleOrigin === "custom" ? `custom rule ${r.ruleId}` : r.source;
    console.log(`${VERDICT_ICON[r.verdict]} ${r.verdict}  (${strengthOrConfidence}, via ${via})`);
    console.log(`   test: ${r.testName}`);
    if (r.evidenceLine) console.log(`   evidence: ${r.evidenceLine}`);
    console.log(`   why: ${r.explanation}\n`);
  }

  console.log("Summary:", summary);
}

async function runHistory(argv: string[]): Promise<void> {
  // Loaded lazily: history needs node:sqlite (Node >= 22.5), and a static
  // import would make even `analyze` fail to start on a Node without it.
  let history: typeof import("./history-cli.js");
  try {
    history = await import("./history-cli.js");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_UNKNOWN_BUILTIN_MODULE") {
      console.error(
        `"flaky-finder history" needs the built-in node:sqlite module, which this Node.js (${process.version}) doesn't provide. Use Node.js 22.5 or newer.`,
      );
      process.exit(1);
    }
    throw err;
  }
  history.runHistoryCommand(argv);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    if (first === undefined) usageError("No command given.");
    console.log(USAGE);
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(readVersion());
    return;
  }

  // "history" and "analyze" are reserved subcommand names, distinct from
  // analyzing a log file — a CI log file named literally "history" would
  // need to be passed as ./history (or via `analyze history`).
  if (first === "history") return runHistory(rest);
  if (first === "analyze") return runAnalyze(rest);
  return runAnalyze(argv);
}

main();
