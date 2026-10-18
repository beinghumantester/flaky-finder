#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseLog } from "./parser.js";
import { classifyWithRules } from "./rules.js";
import { classifyWithLlm, hasLlmFallback } from "./llm.js";
import type { AnalysisResult } from "./types.js";

const VERDICT_ICON: Record<AnalysisResult["verdict"], string> = {
  ENVIRONMENT_SIGNAL_DETECTED: "🟡",
  SUSPECTED_REGRESSION: "🔴",
  UNVERIFIED: "⚪",
};

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: flaky-finder analyze <ci-log-file>");
    process.exit(1);
  }

  const raw = readFileSync(file, "utf8");
  const failures = parseLog(raw);
  console.log(`Parsed ${failures.length} failure(s) from ${file}`);
  console.log(hasLlmFallback() ? "LLM fallback: enabled\n" : "LLM fallback: disabled (rules-only mode)\n");

  const results: AnalysisResult[] = [];
  for (const failure of failures) {
    let result = classifyWithRules(failure);
    if (result.source === "none" && hasLlmFallback()) {
      result = await classifyWithLlm(failure);
    }
    results.push(result);
  }

  for (const r of results) {
    console.log(`${VERDICT_ICON[r.verdict]} ${r.verdict}  (${r.confidence} confidence, via ${r.source})`);
    console.log(`   test: ${r.testName}`);
    if (r.evidenceLine) console.log(`   evidence: ${r.evidenceLine}`);
    console.log(`   why: ${r.explanation}\n`);
  }

  const summary = results.reduce(
    (acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }),
    {} as Record<string, number>
  );
  console.log("Summary:", summary);
}

main();
