#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { extractFailures } from "./parser.js";
import { analyzeFailure, collectLogSignals } from "./analysis.js";
import { cleanLog } from "./log-cleaning.js";
import { hasApiKey, llmEndpointHost, queryLlm } from "./llm.js";
import { CustomRuleError, loadCustomRules } from "./custom-rules.js";
import { groupFailures, GROUP_LIMITATION } from "./failure-grouping.js";
import { toPublicDiagnostics } from "./public-output.js";
import type { AnalysisResult, Rule, Verdict } from "./types.js";

// The version of the `analyze --json` contract (docs/json-output.md). Bumped when a
// field is removed, renamed or changes meaning. Version 2: failure counts, the
// meaning of UNVERIFIED (now with abstainReason), evidence locations, and
// unattributed signals all changed with evidence-boundary extraction. History
// output has its own version in history-cli.ts.
export const JSON_SCHEMA_VERSION = 2;

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
  --json                  Print one JSON object to stdout instead of human-readable text
  --include-weak-groups   Include matchStrength:"weak" rules in the failure signature summary (excluded by default)
  --llm                   Send the primary evidence of failures no rule matched to the LLM endpoint.
                          Off by default: this transmits log text to FLAKY_FINDER_BASE_URL (Groq unless set).

Environment:
  FLAKY_FINDER_RULES_FILE   Path to a JSON file of custom rules, checked before the built-ins (analyze only)
  FLAKY_FINDER_BASE_URL     OpenAI-compatible endpoint for --llm (default: Groq; a local Ollama works too)
  FLAKY_FINDER_API_KEY      Key sent with --llm requests. Optional: a local endpoint may need none`;

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
        "include-weak-groups": { type: "boolean", default: false },
        llm: { type: "boolean", default: false },
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

  const { failures, diagnostics } = extractFailures(raw);
  // The only form of a diagnostic that may be printed: never the internal one,
  // whose text can hold anything extraction rejected. See public-output.ts.
  const publicDiagnostics = toPublicDiagnostics(diagnostics);

  // The LLM step runs only when asked for. A configured key alone is not consent
  // to send CI log text to a hosted provider.
  const llmEnabled = values.llm;
  if (llmEnabled) {
    console.error(
      `LLM: primary evidence of eligible failures that no rule matched will be sent to ${llmEndpointHost()}`,
    );
    if (!hasApiKey())
      console.error(
        "LLM: FLAKY_FINDER_API_KEY is not set; requests are sent without a key (fine for a local endpoint)",
      );
  } else if (hasApiKey()) {
    console.error("LLM: FLAKY_FINDER_API_KEY is set but --llm was not given, so the LLM step is off");
  }

  const results: AnalysisResult[] = [];
  for (const failure of failures) {
    results.push(await analyzeFailure(failure, customRules, llmEnabled ? (f) => queryLlm(f) : null));
  }
  const unattributedSignals = collectLogSignals(cleanLog(raw).split("\n"), failures, results, customRules);
  const llmUnavailable = results.filter((r) => r.abstainReason === "llm-unavailable").length;

  // Every verdict is always present (zero-filled), so a consumer never has
  // to treat a missing key as zero.
  const summary: Record<Verdict, number> = { ENVIRONMENT_SIGNAL_DETECTED: 0, SUSPECTED_REGRESSION: 0, UNVERIFIED: 0 };
  for (const r of results) summary[r.verdict] += 1;

  // A read-only view over `results` grouped by which rule decided their
  // verdict — see failure-grouping.ts for what this does and doesn't
  // establish. Never changes a result; always safe to compute.
  const failureGroups = groupFailures(results, { includeWeak: values["include-weak-groups"] });

  if (values.json) {
    const output = {
      schemaVersion: JSON_SCHEMA_VERSION,
      tool: { name: "flaky-finder", version: readVersion() },
      input: file,
      llmFallback: llmEnabled,
      customRules: rulesFile ? { path: rulesFile, count: customRules.length } : null,
      results,
      failureGroups,
      summary,
      unattributedSignals,
      diagnostics: publicDiagnostics,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Parsed ${failures.length} failure(s) from ${file}`);
  if (rulesFile) console.log(`Custom rules: ${customRules.length} loaded from ${rulesFile} (checked before built-ins)`);
  console.log(llmEnabled ? "LLM fallback: enabled (--llm)\n" : "LLM fallback: disabled (rules-only mode)\n");

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
    if (r.extraction) {
      const e = r.extraction;
      console.log(
        `   lines: ${e.span.startLine}-${e.span.endLine} (${e.boundary}, ${e.method}${e.phase !== "unknown" ? `, ${e.phase}` : ""})`,
      );
    }
    if (r.evidenceLine) {
      const at = r.evidenceLocation ? ` (line ${r.evidenceLocation.startLine})` : "";
      console.log(`   evidence${at}: ${r.evidenceLine}`);
    }
    if (r.abstainReason) console.log(`   abstained: ${r.abstainReason}`);
    console.log(`   why: ${r.explanation}`);
    // Other rules that matched but lost on precedence — shown, never hidden.
    for (const m of r.alsoMatched ?? []) {
      console.log(`   also matched (did not decide the verdict): ${m.ruleId} [${m.category}] — ${m.evidenceLine}`);
    }
    // Signals in this failure's context or in an ineligible block — shown, never used.
    for (const u of r.unattributedSignals ?? []) {
      console.log(
        `   unattributed signal (${u.where}, line ${u.line}, did not decide the verdict): ${u.ruleId} — ${u.evidenceLine}`,
      );
    }
    console.log("");
  }

  if (unattributedSignals.length > 0) {
    console.log("Signals that decided no verdict (in context, in unattributed blocks, or outside every failure):");
    for (const s of unattributedSignals) {
      console.log(`  ${s.ruleId} [${s.category}] x${s.count}, first at line ${s.firstLine}: ${s.firstEvidenceLine}`);
    }
    console.log("");
  }

  if (publicDiagnostics.length > 0) {
    const shown = publicDiagnostics.slice(0, 20);
    console.log(`Declined by extraction (${publicDiagnostics.length} line(s) not treated as failures):`);
    for (const d of shown) console.log(`  line ${d.line ?? "?"}: ${d.code} — ${d.message}`);
    if (publicDiagnostics.length > shown.length) {
      console.log(`  ... and ${publicDiagnostics.length - shown.length} more (see --json for all)`);
    }
    console.log("");
  }

  // Only printed when at least one group exists — most runs won't have a
  // rule repeat, and an empty section on every normal run would be noise
  // the way an empty history table isn't (history-cli always has something
  // to say about what to do next; here there's nothing to act on).
  if (failureGroups.length > 0) {
    console.log("Failure signature groups (same rule matched more than once — see limitation below):");
    for (const g of failureGroups) {
      const via = g.ruleOrigin === "custom" ? `custom rule ${g.ruleId}` : g.ruleId;
      console.log(
        `  ${g.occurrenceCount}x ${via}  [${g.category}, ${g.matchStrength}]  (${g.affectedTestCount} test(s) affected)`,
      );
      // Representative evidence only — dumping every identical line would
      // make this section longer than the output it's meant to summarize.
      // All of them are still in observations in --json.
      const shown = g.observations.slice(0, 3);
      for (const o of shown) console.log(`     - ${o.testName}: ${o.evidenceLine}`);
      if (g.observations.length > shown.length) {
        console.log(`     ... and ${g.observations.length - shown.length} more (see --json for all)`);
      }
    }
    console.log(`  ${GROUP_LIMITATION}\n`);
  }

  if (llmUnavailable > 0) console.log(`LLM unavailable for ${llmUnavailable} of ${results.length} failure(s)`);
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
