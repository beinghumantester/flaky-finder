# JSON output contract (`--json`)

Every command that accepts `--json` prints **exactly one JSON object to
stdout** and nothing else. Warnings (for example Node's `node:sqlite`
`ExperimentalWarning`) and errors go to stderr. This page is the contract
for that output; `tests/cli.test.ts` checks that the field names below
don't change by accident.

## Compatibility rules

- Every object has a top-level `schemaVersion` (currently `1`).
- `schemaVersion` is bumped only when a field is **removed, renamed, or
  changes meaning**.
- New fields can appear **without** a bump. Ignore fields you don't
  recognize.
- A field documented as "optional" can be missing. Don't treat a missing
  field as `null` or `0` unless this page says so.
- Exit codes don't depend on verdicts: `0` on success, `1` for a runtime
  error (unreadable file, bad rules file), `2` for a usage error (unknown
  flag, missing argument). On exit code 1 or 2, stdout is empty and the
  reason is on stderr.

## `analyze --json`

```json
{
  "schemaVersion": 1,
  "tool": { "name": "flaky-finder", "version": "0.1.0" },
  "input": "ci.log",
  "llmFallback": false,
  "customRules": { "path": "team-rules.json", "count": 2 },
  "results": [ /* one per failure found, see below */ ],
  "failureGroups": [ /* results grouped by which rule decided them, see below */ ],
  "summary": { "ENVIRONMENT_SIGNAL_DETECTED": 1, "SUSPECTED_REGRESSION": 0, "UNVERIFIED": 1 }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | object | Name and version that produced this output. |
| `input` | string | The log file path as given. |
| `llmFallback` | boolean | Whether the optional LLM step was enabled for this run. |
| `customRules` | object or `null` | `{ path, count }` when `FLAKY_FINDER_RULES_FILE` was set, else `null`. |
| `results` | array | One result per failure, in log order. Never changed by grouping. |
| `failureGroups` | array | `results` grouped by which rule decided them — may be empty. See below. |
| `summary` | object | Count per verdict. All three verdicts are always present (zero-filled). |

### Each result

| Field | Present | Meaning |
| --- | --- | --- |
| `testName` | always | Test name as parsed from the log (`unrecognized-log-format` if the format wasn't recognized). |
| `framework` | always | `pytest`, `jest`, `playwright`, or `generic`. |
| `verdict` | always | `ENVIRONMENT_SIGNAL_DETECTED`, `SUSPECTED_REGRESSION`, or `UNVERIFIED`. |
| `source` | always | `rule` (a rule matched), `llm` (the LLM step classified it), or `none` (nothing did). |
| `confidence` | always | **Depends on `source`.** For `rule`: match strength `exact`/`strong`/`weak` (how specific the matched text is, not a probability). For `llm`: the model's own stated confidence, `medium`/`low`. For `none`: `none`. |
| `explanation` | always | Human-readable reasoning, including what the evidence does *not* establish. |
| `ruleId` | when `source` is `rule` | The rule that decided the verdict. |
| `ruleOrigin` | when `source` is `rule` | `builtin` or `custom`. |
| `category` | when `source` is `rule` | The rule's category, e.g. `network`, `timing`. |
| `evidenceLine` | when `source` is `rule` | Text the rule actually matched: the full matching line, or, for a multi-line custom rule, exactly the matched text (may contain `\n`). Taken from the log **after** ANSI codes and CI timestamps were stripped. |
| `alsoMatched` | when `source` is `rule` (may be `[]`) | Every other rule that also matched, in precedence order. They didn't decide the verdict. Each item has `ruleId`, `ruleOrigin`, `category`, `verdict`, `matchStrength`, `evidenceLine`. |

`SUSPECTED_REGRESSION` can only come from the LLM step, and only with
`low` confidence. No rule, built-in or custom, can produce it.

### Each failure group (`failureGroups`)

A group is an additional, read-only VIEW over `results` — every observation
it contains is also, unchanged, in the top-level `results` array. Only
results with `source: "rule"` are eligible; `matchStrength: "weak"` rules
are excluded by default (pass `--include-weak-groups` to include them). A
rule that matched only one failure is not reported as a group at all.

| Field | Meaning |
| --- | --- |
| `groupingMethod` | Always `"rule_id"` today — the only grouping key this version implements. |
| `ruleId`, `ruleOrigin`, `matchStrength`, `category` | The grouped rule's own fields (see `results` above). |
| `occurrenceCount` | Number of failure **observations** in this group — not distinct tests. A test that fails twice under the same rule (e.g. a retry-plugin duplicate) counts twice. |
| `affectedTestCount` | Number of **distinct** test identities in this group. Can be less than `occurrenceCount`. |
| `affectedTestIds` | The distinct `testName` values in this group. |
| `observations` | Every grouped result in full, unmodified. |
| `limitation` | A fixed sentence, identical on every group: a shared rule match is a shared classification signature, not a confirmed shared root cause. Independent failures can produce the identical signature, and one real incident can produce several different ones. This is **not** a root-cause or incident-correlation feature — see the README's Roadmap for what's deliberately out of scope here. |

## `history ingest --json`

New report recorded (`skipped: false`):

| Field | Meaning |
| --- | --- |
| `db`, `file` | Database path and report path used. |
| `skipped` | `false`. |
| `ingestionId` | Database id of this ingestion. |
| `runId`, `commitSha`, `environmentId`, `framework` | What the runs were recorded under (`commitSha`/`environmentId` may be `null`). |
| `totalCases`, `counts` | Test cases found, and counts per outcome: `PASSED`, `FAILED`, `SKIPPED`, `UNKNOWN`. |
| `warnings` | Non-fatal parse issues (array of strings, may be empty). |

Same report under the same `--run-id` again (`skipped: true`):
`db`, `file`, `skipped`, `reason` (`"duplicate"`), `existingIngestionId`,
`existingIngestedAt`. Nothing was recorded.

## `history show <query> --json`

`{ schemaVersion, db, query, tests }`. `tests` is an array of test
summaries: one for an exact test id match, several if the query matched
more than one tracked test, or empty if nothing matched.

## `history report --json`

`{ schemaVersion, db, tests, summary }`. `tests` is every tracked test's
summary (filtered by `--framework` if given). `summary` counts tests per
assessment; all four assessments are always present.

### Test summary (used by `show` and `report`)

| Field | Meaning |
| --- | --- |
| `testId` | `<framework>::<classname>::<name>`. |
| `testName`, `classname`, `framework` | Identity parts (`classname` may be `null`). |
| `totalRuns`, `counts` | Recorded runs, and counts per outcome. |
| `distinctCommits` | How many different commit SHAs the runs cover. |
| `firstSeen`, `lastSeen` | ISO-8601 timestamps of the first and last recorded run. |
| `assessment` | `INTERMITTENCY_OBSERVED`, `FAILURE_REPEATED`, `PASS_ONLY`, or `INSUFFICIENT_HISTORY`. |
| `assessmentExplanation` | What the assessment does and doesn't establish. |
| `recentRuns` | Up to the 10 most recent runs, newest first (`totalRuns` has the full count): `runId`, `commitSha`, `outcome`, `recordedAt`, `ruleId`, `evidenceLine` (the last two are `null` unless the run failed with a matched rule). |

A history assessment and a log verdict are **different things**. One
describes recorded run history, the other a single log. Don't merge them
into one field when you consume this output.
