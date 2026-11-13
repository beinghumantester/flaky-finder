import { extractFailures } from "./parser.js";
import { analyzeFailure, collectLogSignals, type LlmClassifier } from "./analysis.js";
import { cleanLog } from "./log-cleaning.js";
import { groupFailures } from "./failure-grouping.js";
import { toPublicDiagnostics } from "./public-output.js";
import type { AnalysisResult, FailureGroup, LogSignal, PublicDiagnostic, Rule, Verdict } from "./types.js";

export interface AnalyzeLogOptions {
  /** Custom rules, checked before the built-ins. */
  customRules?: Rule[];
  /** Classifier for failures no rule matched; null (the default) keeps the run rules-only. */
  llm?: LlmClassifier | null;
  /** Include matchStrength:"weak" rules in the failure signature groups. */
  includeWeakGroups?: boolean;
}

export interface LogAnalysis {
  /** Number of failures extraction found; equal to results.length. */
  failureCount: number;
  /** One result per extracted failure, in log order. */
  results: AnalysisResult[];
  /** Results grouped by the rule that decided them. Never changes a result. */
  failureGroups: FailureGroup[];
  /** Count per verdict, always zero-filled. */
  summary: Record<Verdict, number>;
  /** Signals that decided no verdict. */
  unattributedSignals: LogSignal[];
  /** The only form of extraction diagnostics that may be shown. See public-output.ts. */
  diagnostics: PublicDiagnostic[];
}

/**
 * Analyzes one CI log's text: extraction, then per-failure analysis, then the
 * log-level views. This is the single analysis entry point shared by every
 * interface (the CLI today). It never prints, never reads files and never exits.
 */
export async function analyzeLog(raw: string, options: AnalyzeLogOptions = {}): Promise<LogAnalysis> {
  const customRules = options.customRules ?? [];
  const llm = options.llm ?? null;

  const { failures, diagnostics } = extractFailures(raw);
  // The internal diagnostic text can hold anything extraction rejected, so only
  // the public form leaves this function.
  const publicDiagnostics = toPublicDiagnostics(diagnostics);

  const results: AnalysisResult[] = [];
  for (const failure of failures) {
    results.push(await analyzeFailure(failure, customRules, llm));
  }
  const unattributedSignals = collectLogSignals(cleanLog(raw).split("\n"), failures, results, customRules);

  // Every verdict is always present (zero-filled), so a consumer never has
  // to treat a missing key as zero.
  const summary: Record<Verdict, number> = { ENVIRONMENT_SIGNAL_DETECTED: 0, SUSPECTED_REGRESSION: 0, UNVERIFIED: 0 };
  for (const r of results) summary[r.verdict] += 1;

  // A read-only view over `results` grouped by which rule decided their
  // verdict — see failure-grouping.ts for what this does and doesn't
  // establish. Never changes a result; always safe to compute.
  const failureGroups = groupFailures(results, { includeWeak: options.includeWeakGroups ?? false });

  return {
    failureCount: failures.length,
    results,
    failureGroups,
    summary,
    unattributedSignals,
    diagnostics: publicDiagnostics,
  };
}
