# JSON output contract (`--json`)

Every command that accepts `--json` prints **exactly one JSON object to
stdout** and nothing else. Warnings (for example Node's `node:sqlite`
`ExperimentalWarning`) and errors go to stderr. This page is the contract
for that output; `tests/cli.test.ts` checks that the field names below
don't change by accident.

## Compatibility rules

- Every object has a top-level `schemaVersion`. `analyze` output is at **`2`**;
  `history` output is at `1`. Each command's version describes that command's
  own JSON contract. The SQLite schema version is a third, separate contract.
- `schemaVersion` is bumped only when a field is **removed, renamed, or
  changes meaning**. Version 2 of `analyze` changed meaning: failure counts
  (one observation per extracted failure, repeated reports merged), the meaning
  of `UNVERIFIED` (now always with an `abstainReason`), and the link between
  evidence and its location in the log.
- New fields can appear **without** a bump. Ignore fields you don't
  recognize, and treat unknown `abstainReason` values as "abstained for a
  reason this consumer does not know": a later reason code is not a breaking
  change.
- A field documented as "optional" can be missing. Don't treat a missing
  field as `null` or `0` unless this page says so.
- Exit codes don't depend on verdicts: `0` on success, `1` for a runtime
  error (unreadable file, bad rules file), `2` for a usage error (unknown
  flag, missing argument). On exit code 1 or 2, stdout is empty and the
  reason is on stderr.

## `analyze --json`

```json
{
  "schemaVersion": 2,
  "tool": { "name": "flaky-finder", "version": "0.1.0" },
  "input": "ci.log",
  "llmFallback": false,
  "customRules": { "path": "team-rules.json", "count": 2 },
  "results": [ /* one per failure found, see below */ ],
  "failureGroups": [ /* results grouped by which rule decided them, see below */ ],
  "summary": { "ENVIRONMENT_SIGNAL_DETECTED": 1, "SUSPECTED_REGRESSION": 0, "UNVERIFIED": 1 },
  "unattributedSignals": [ /* rule matches that decided nothing, one per rule, see below */ ],
  "diagnostics": [ /* lines extraction declined to treat as failures, see below */ ]
}
```

A complete version 2 example, for a log with one failure decided by a rule and
one the rules could not place:

```json
{
  "schemaVersion": 2,
  "tool": { "name": "flaky-finder", "version": "0.1.0" },
  "input": "ci.log",
  "llmFallback": false,
  "customRules": null,
  "results": [
    {
      "testName": "test_fetch_user_retries",
      "framework": "pytest",
      "verdict": "ENVIRONMENT_SIGNAL_DETECTED",
      "confidence": "exact",
      "category": "network",
      "ruleId": "network-reset",
      "ruleOrigin": "builtin",
      "evidenceLine": "E       requests.exceptions.ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))",
      "evidenceLocation": { "startLine": 7, "endLine": 7 },
      "explanation": "...",
      "source": "rule",
      "alsoMatched": [],
      "unattributedSignals": [],
      "extraction": {
        "method": "pytest-failures-section",
        "boundary": "complete",
        "span": { "startLine": 2, "endLine": 9 },
        "phase": "call"
      },
      "segments": [{ "startLine": 2, "endLine": 9, "text": "_____ test_fetch_user_retries _____\n..." }]
    },
    {
      "testName": "test_discount_calculation",
      "framework": "pytest",
      "verdict": "UNVERIFIED",
      "confidence": "none",
      "explanation": "No known failure signature matched. ...",
      "source": "none",
      "abstainReason": "no-rule-matched",
      "unattributedSignals": [],
      "extraction": {
        "method": "pytest-failures-section",
        "boundary": "complete",
        "span": { "startLine": 10, "endLine": 17 },
        "phase": "call"
      },
      "segments": [{ "startLine": 10, "endLine": 17, "text": "..." }]
    }
  ],
  "failureGroups": [],
  "summary": { "ENVIRONMENT_SIGNAL_DETECTED": 1, "SUSPECTED_REGRESSION": 0, "UNVERIFIED": 1 },
  "unattributedSignals": [],
  "diagnostics": []
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | object | Name and version that produced this output. |
| `input` | string | The log file path as given. |
| `llmFallback` | boolean | Whether the optional LLM step was enabled for this run (`--llm`). |
| `customRules` | object or `null` | `{ path, count }` when `FLAKY_FINDER_RULES_FILE` was set, else `null`. |
| `results` | array | One result per failure, in log order. Never changed by grouping. |
| `failureGroups` | array | `results` grouped by which rule decided them — may be empty. See below. |
| `summary` | object | Count per verdict. All three verdicts are always present (zero-filled). |
| `unattributedSignals` | array | Rule matches anywhere in the log that decided no verdict: in captured output, in unknown or truncated blocks, or outside every failure. One entry per rule: `ruleId`, `ruleOrigin`, `category`, `matchStrength`, `count` (matching lines), `firstLine`, `firstEvidenceLine`. Read by no classifier. |
| `diagnostics` | array | Lines extraction declined to treat as failures, or merged as repeats: `code`, `message`, and `line` (1-based, in the original log). **Never the line's text**, which was never checked and may hold anything. Codes include `pytest-header-outside-failure-section`, `jest-console-block`, `jest-validation-warning-block`, `jest-bullet-outside-fail-context`, `playwright-item-rejected`, `nested-observation`, `overlapping-observations`, `duplicate-failure-block`, `possible-duplicate`. |

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
| `evidenceLine` | when `source` is `rule`, or `source` is `llm` and the verdict claims a cause | For `rule`: the full matching line, or, for a multi-line custom rule, exactly the matched text (may contain `\n`). Taken from the log **after** ANSI codes and CI timestamps were stripped. For `llm`: the model's own quoted evidence, present only for `ENVIRONMENT_SIGNAL_DETECTED` or `SUSPECTED_REGRESSION`, and only once the tool has confirmed the quote actually appears in the evidence that was sent — a verdict with no checkable quote is rejected instead (`llm-response-rejected`), never silently trusted. |
| `alsoMatched` | when `source` is `rule` (may be `[]`) | Every other rule that also matched, in precedence order. They didn't decide the verdict. Each item has `ruleId`, `ruleOrigin`, `category`, `verdict`, `matchStrength`, `evidenceLine`, and `evidenceLocation` when known. |
| `abstainReason` | when `verdict` is `UNVERIFIED` | Why. One of `boundary-unknown`, `boundary-truncated` (extraction could not attribute the evidence), `context-only-signal`, `no-rule-matched`, `rule-abstained` (the rules), `insufficient-evidence` (the LLM read the evidence and abstained), `llm-unavailable`, `llm-invalid-response`, `llm-response-rejected` (the LLM never gave a usable answer). Accept values you don't know. |
| `evidenceLocation` | when `evidenceLine` is present and the failure came from a log | `{ startLine, endLine }` of `evidenceLine` in the original log, 1-based. Absent (even with `evidenceLine` present) for text with no log position. |
| `extraction` | when the failure came from a log | Where its evidence came from: `method`, `boundary` (`complete`, `truncated`, `unknown`), `span` (`{ startLine, endLine }` of the whole observation), `phase` (`setup`, `call`, `teardown`, `collection`, `unknown`), optional `attempts` (one span per retry) and `contextSpans` (captured output, line ranges only). Only a `complete` observation can get a verdict. |
| `segments` | with `extraction` (may be `[]`) | The primary evidence that was classified: `{ startLine, endLine, text }` each, in log order. Captured output is not in them. |
| `unattributedSignals` | with `extraction` (may be `[]`) | Rule matches in this failure's captured output (`where: "context"`) or, for an unknown or truncated observation, in its text (`where: "ineligible-block"`): `ruleId`, `ruleOrigin`, `category`, `matchStrength`, `evidenceLine`, `line`, `where`. Listed so they are visible; they never decide the verdict. |

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
