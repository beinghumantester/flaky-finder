import type { AnalysisResult, FailureGroup, MatchStrength } from "./types.js";

// Groups an existing array of AnalysisResults by which rule decided their
// verdict. See FailureGroup's comment in types.ts for what a group does and
// does not establish. This module only reads `results` — it never mutates
// an AnalysisResult or reorders the caller's own array.
//
// Eligibility: only results with source === "rule" have a ruleId/category/
// matchStrength to group by. LLM results and UNVERIFIED-from-no-match
// results are never included in any group — they remain visible, unchanged,
// in the caller's own `results` list either way.
//
// Default policy: matchStrength "weak" rules are excluded from grouping.
// Not because a weak match is incorrect — because grouping on a loose,
// generic signature (and, for a custom rule, a SELF-declared "weak" that
// nothing here independently verifies) is the easiest way for this feature
// to manufacture the appearance of a pattern that isn't really there. Pass
// `includeWeak: true` to see weak-rule groups too; this is a policy for
// what gets PROMOTED into a group summary, not a filter on the underlying
// results, which are untouched regardless.
export interface GroupingOptions {
  includeWeak?: boolean;
}

export const GROUP_LIMITATION =
  "This group reflects failure observations that matched the same rule — a shared classification signature, " +
  "not a confirmed shared root cause. Independent, unrelated failures can produce an identical signature, and a " +
  "single real incident can just as easily produce several different ones. Check each observation's own evidence.";

// A rule that matched exactly one failure isn't a pattern to surface
// separately — it's just that failure's own result, already visible in the
// ungrouped list. Below this, nothing is reported as a group.
const MIN_GROUP_SIZE = 2;

export function groupFailures(results: AnalysisResult[], options: GroupingOptions = {}): FailureGroup[] {
  const includeWeak = options.includeWeak ?? false;

  // Keyed on ruleOrigin + ruleId, not ruleId alone. custom-rules.ts already
  // rejects a custom rule whose id collides with a built-in's, so in
  // practice the two can never share an id — but this function doesn't
  // lean on that upstream check to stay correct, the same way
  // history-analysis.ts's assessHistory re-validates an invariant its only
  // current caller already upholds.
  const buckets = new Map<string, AnalysisResult[]>();
  for (const result of results) {
    if (result.source !== "rule" || !result.ruleId || !result.ruleOrigin || !result.category) continue;
    if (result.confidence === "weak" && !includeWeak) continue;
    const key = `${result.ruleOrigin}:${result.ruleId}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(result);
    else buckets.set(key, [result]);
  }

  const groups: FailureGroup[] = [];
  for (const observations of buckets.values()) {
    if (observations.length < MIN_GROUP_SIZE) continue;
    const first = observations[0];
    const affectedTestIds = [...new Set(observations.map((o) => o.testName))];
    groups.push({
      groupingMethod: "rule_id",
      ruleId: first.ruleId!,
      ruleOrigin: first.ruleOrigin!,
      matchStrength: first.confidence as MatchStrength,
      category: first.category!,
      occurrenceCount: observations.length,
      affectedTestCount: affectedTestIds.length,
      affectedTestIds,
      observations,
      limitation: GROUP_LIMITATION,
    });
  }

  // Largest group first: the pattern most worth a human's attention leads.
  // Tie-broken by ruleId so output order is deterministic, not insertion-order.
  groups.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.ruleId.localeCompare(b.ruleId));
  return groups;
}
