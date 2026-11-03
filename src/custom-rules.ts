import { readFileSync } from "node:fs";
import { RULES } from "./rules.js";
import type { MatchStrength, Rule, Verdict } from "./types.js";

// A team's own failure signatures (e.g. a known-unreliable internal
// hostname) without forking rules.ts. Rules are DATA, not code: a JSON file
// with a regex string and an explanation template, so loading one can never
// execute anything, and the file itself is the audit trail of what was added.
//
// The same contract as the built-in rules applies, and is enforced here
// rather than trusted:
//   - verdict may only be ENVIRONMENT_SIGNAL_DETECTED or UNVERIFIED — no rule,
//     built-in or custom, is allowed to claim SUSPECTED_REGRESSION from text
//     matching alone;
//   - every match still cites its evidence line and gets the same uniform
//     "this is not proof" caveat from classifyWithRules.
//
// Custom rules are checked BEFORE the built-ins (see classifyWithRules): an
// org-specific signature is usually more specific than a generic one (a
// reset to one known internal host vs. any ECONNRESET), and precedence is
// first-match-wins.
//
// Wiring: cli.ts's analyze path loads the file named by the
// FLAKY_FINDER_RULES_FILE env var. history ingest does NOT use custom rules
// yet — history stores the built-in RULESET_VERSION with every piece of
// evidence, and that number says nothing about a team's custom rules.

const ALLOWED_VERDICTS: Verdict[] = ["ENVIRONMENT_SIGNAL_DETECTED", "UNVERIFIED"];
const ALLOWED_STRENGTHS: MatchStrength[] = ["exact", "strong", "weak"];
// No "g" or "y": RegExp.test() with either is stateful (it advances
// lastIndex), so the same rule could match one failure and miss the next.
const ALLOWED_FLAGS = /^[imsu]*$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export class CustomRuleError extends Error {}

interface CustomRuleJson {
  id: unknown;
  category: unknown;
  verdict: unknown;
  matchStrength: unknown;
  pattern: unknown;
  flags?: unknown;
  explanation?: unknown;
}

function fail(file: string, where: string, message: string): never {
  throw new CustomRuleError(`${file}: ${where}: ${message}`);
}

function toRule(file: string, index: number, raw: CustomRuleJson, seenIds: Set<string>): Rule {
  const where = `rules[${index}]`;
  if (typeof raw !== "object" || raw === null) fail(file, where, "must be an object");

  const { id, category, verdict, matchStrength, pattern, flags = "i", explanation } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    fail(file, where, `"id" must be a lowercase kebab-case string (got ${JSON.stringify(id)})`);
  }
  if (seenIds.has(id)) fail(file, where, `duplicate id "${id}" (ids must be unique, including built-in rule ids)`);
  seenIds.add(id);

  if (typeof category !== "string" || category.trim() === "")
    fail(file, where, `"category" must be a non-empty string`);
  if (!ALLOWED_VERDICTS.includes(verdict as Verdict)) {
    fail(file, where, `"verdict" must be one of ${ALLOWED_VERDICTS.join(", ")} (got ${JSON.stringify(verdict)})`);
  }
  if (!ALLOWED_STRENGTHS.includes(matchStrength as MatchStrength)) {
    fail(file, where, `"matchStrength" must be one of ${ALLOWED_STRENGTHS.join(", ")}`);
  }
  if (typeof pattern !== "string" || pattern === "") fail(file, where, `"pattern" must be a non-empty regex string`);
  if (typeof flags !== "string" || !ALLOWED_FLAGS.test(flags)) {
    fail(file, where, `"flags" may only contain i, m, s, u (got ${JSON.stringify(flags)})`);
  }
  if (explanation !== undefined && typeof explanation !== "string") fail(file, where, `"explanation" must be a string`);

  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, flags);
  } catch (err) {
    fail(file, where, `"pattern" is not a valid regex: ${(err as Error).message}`);
  }

  // "{line}" in the template is replaced with the matched evidence line.
  const template = explanation ?? `Custom rule "${id}" matched ({line}).`;
  return {
    id,
    category,
    verdict: verdict as Verdict,
    matchStrength: matchStrength as MatchStrength,
    pattern: compiled,
    explain: (line) => template.replaceAll("{line}", line.trim()),
    origin: "custom",
  };
}

/** Parses and validates a rules file's contents. Throws CustomRuleError with the file and rule index on any problem. */
export function parseCustomRules(json: string, file = "<rules>"): Rule[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new CustomRuleError(`${file}: not valid JSON: ${(err as Error).message}`);
  }
  const rules = (data as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) throw new CustomRuleError(`${file}: expected an object with a "rules" array`);

  const seenIds = new Set(RULES.map((rule) => rule.id));
  return rules.map((raw, index) => toRule(file, index, raw as CustomRuleJson, seenIds));
}

/** Reads and validates a rules file. A missing or unreadable file is an error, never "zero rules". */
export function loadCustomRules(path: string): Rule[] {
  let json: string;
  try {
    json = readFileSync(path, "utf8");
  } catch (err) {
    throw new CustomRuleError(`Could not read rules file ${path}: ${(err as Error).message}`);
  }
  return parseCustomRules(json, path);
}
