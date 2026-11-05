# Design: failure evidence boundaries

**Status:** approved in review, with the additions below. No parser code has
been changed. Implementation waits until the 49 logs are labeled.
**Branch:** `fix/real-world-log-extraction`, from `85d34e2`.
**Scope:** steps 1 and 2 of the real log plan: failure boundaries, framework
detection, and parser correctness. Rule changes and new signatures come later.

## The problem

flaky-finder cannot yet say reliably which log lines belong to which test
failure. A rule can only be as trustworthy as the text it is given, so this
has to be solved before rules are tightened.

The six false signals from the real log test are examples of this problem, not
the definition of it. The goal is one general guarantee:

> A failure signal can influence a verdict only when the tool can establish that
> the signal belongs to the failure being analyzed. Every observation states
> which original log lines it came from, and text outside them cannot decide its
> verdict.

No built-in rules are added during this phase. The aim is not to recognize more
failure messages, but to make sure the evidence used belongs to the failure it
claims to explain.

## Current architecture

| Stage | Where | Behavior |
| --- | --- | --- |
| Cleaning | `log-cleaning.ts` | Removes ANSI codes, CRLF and GitHub Actions timestamps |
| Detection | `parseLog` in `parser.ts` | Picks **one** framework for the whole log, in a fixed order: pytest, Jest, Playwright |
| Extraction | `parsePytest`, `parseJest`, `parsePlaywright` | Splits on a header pattern. The last block runs to the end of the log |
| Fallback | `parseLog` | Treats the entire log as one `generic` failure |
| Matching | `classifyWithRules` in `rules.ts` | Tests every rule against `Failure.rawText` |

`Failure` holds only `testName`, `framework` and `rawText`, so no line position
survives. `rawText` also feeds the LLM step in `llm.ts`. `history-ingest.ts`
builds its own `Failure` from JUnit text and never calls `parseLog`.

Four weaknesses follow from this:

1. **Blocks have a start but no end.** Anything after the last header joins the
   last failure.
2. **A header pattern is treated as proof of a failure.** Any `●` line or
   `124) echo` line becomes a test.
3. **One framework per log is assumed.** A log with a `●` spinner line and
   Playwright output is read as Jest.
4. **The fallback gives the entire log to the rules,** including passing output
   and shell scripts.

## What the 49 real logs show

Measured on the saved baseline. These logs informed the design, so they cannot
also serve as its independent validation.

### Line numbers

- Cleaning preserved the line count on 49 of 49 logs, so a cleaned line index
  maps directly to the original line.
- All 49 logs start with a byte order mark, which stops the timestamp on line 1
  from being removed.

### pytest

- 92 failure style headers were found. 85 sit inside a `FAILURES` or `ERRORS`
  section. The other 7 are the 5 `sentry` `FLAKES` entries and 2
  `home-assistant` `coverage:` lines, none of which are new failures.
- Sections following the failure region include `short test summary info`,
  `warnings summary`, `FLAKES (original error)` and `slowest N durations`.
- 19 lines are `_ _ _ _` traceback separators, so a looser header pattern alone
  would create false failures.
- 3 logs contain more than one pytest session, and at least one is **nested**: in
  `pytest-dev/pytest`, a whole inner session (`45 failed, 2 errors`) is printed
  inside one failing test, whose job's real result is `1 failed`.
- The `airflow` duplicates are inside the failure region, and that log prints
  the same final summary twice. The output appears to be repeated, which is a
  different cause from `FLAKES`. To be confirmed during implementation.

### Jest

| Context of the `●` line | Other bullets | `Console` | `Validation Warning` |
| --- | --- | --- | --- |
| Under a `FAIL <file>` line | 29 | 1 | 0 |
| In `Summary of all failing tests` | 24 | 0 | 0 |
| Under a `PASS <file>` line | 0 | 12 | 0 |
| No test file context | 41 | 1 | 24 |

The 41 include the 4 `strapi` `Installing template` lines. Most of the rest are
from `jestjs/jest`, whose logs contain nested test output, so that repository
is not a clean reference.

### Playwright

- All 10 failure items ended at either the next item (2) or a count line such
  as `1 failed` (8).
- `Retry #1` markers appear inside items, on 6 lines across 3 projects.

## Proposed model

```typescript
// 1-based and inclusive, in the original log file.
interface LineSpan {
  startLine: number;
  endLine: number;
}

type BoundaryState =
  | "complete"   // a framework marker ended the block
  | "truncated"  // the log ended before any end marker
  | "unknown";   // no framework structure was recognized

type FailurePhase = "setup" | "call" | "teardown" | "collection" | "unknown";

interface FailureExtraction {
  method: string;          // for example "pytest-failures-section"
  boundary: BoundaryState;
  span: LineSpan;          // the whole observation
  phase: FailurePhase;
  attempts?: LineSpan[];   // one span per retry, in order
  contextSpans?: LineSpan[]; // captured output: kept, but not primary evidence
}

interface Failure {
  testName: string;
  framework: "pytest" | "jest" | "playwright" | "generic"; // unchanged
  rawText: string;         // primary evidence only
  extraction?: FailureExtraction;
}
```

- **Boundary state, not confidence.** These three values state what was
  observed. A `high` or `low` label would imply a judgment nothing calculates,
  which is the same reason rule matches are not called confidence.
- **`extraction` is optional on purpose.** Text from `history-ingest.ts`,
  `evaluation/` and direct callers has no log position, so those paths keep
  working unchanged and their behavior does not shift.
- **Line numbers come from cleaned line indexes,** which is safe only while
  cleaning keeps lines one to one. A test will enforce that.

## Proposed flow

```text
Raw log
  -> Clean, keeping lines one to one
  -> Run every extractor; each looks only for its own structure
  -> Merge observations in log order, then remove exact duplicates
  -> If there are none: one observation with boundary "unknown"
  -> Match rules against primary evidence only
  -> Classify
```

There is no longer a step that picks one framework. Detection becomes "did this
extractor find its own structure", so a log can contain several frameworks and
checking order stops mattering. This fixes the `strapi` case by design.

Each extractor is a separate function with one contract: it receives cleaned
lines and returns observations with spans.

### pytest

- **Region:** starts at `=== FAILURES ===` or `=== ERRORS ===`, and ends at the
  next `=== ... ===` line. Each session gets its own region.
- **Block:** starts at a `_ name _` header of any underscore length, excluding
  `_ _ _ _` separators, and ends at the next header or the end of the region.
- **Phase:** `ERROR at setup of`, `ERROR at teardown of` and `ERROR collecting`
  set the phase. Otherwise it is `call`.
- **Context:** `Captured stdout`, `Captured stderr` and `Captured log` sections
  go in `contextSpans`.
- **Other sections:** `FLAKES` and similar create no observation.
- **Nested sessions:** a `test session starts` line inside a failure region is
  output of that failure, not a new session. Its headers, sections and summary
  stay inside the outer block and create no observations. The outer session's own
  final summary ends the region. This is a confirmed case, not a theoretical one.
- **Known risk:** other captured output containing an `=== x ===` line could still
  end a region early. This needs a test.

### Jest

- **Context:** a `●` line counts only under a `FAIL <file>` line or inside
  `Summary of all failing tests`.
- **Not failures:** `Console` and `Validation Warning` blocks.
- **Block end:** the next `●`, `FAIL` or `PASS` line, `Test Suites:`,
  `Summary of all failing tests`, or a `##[` marker.
- **Duplicates:** a summary entry with the same test name and text as an earlier
  entry is not a new observation.
- **Nested output:** Jest's own repository prints inner `FAIL` and `●` lines inside
  a failure, the same problem as nested pytest sessions.
- **Risk to check:** a real failure printed with no `FAIL` line would be lost.
  The comparison run must report every `●` line this rule drops.

### Playwright

- **Item:** a number and `)`, followed by text containing `›` and a `file:line:col` location.
  A shell line such as `124) echo` matches neither.
- **Block end:** the next item, a count line such as `1 failed`, or a `##[` marker.
- **Retries:** a `Retry #N` line stays inside the item and starts a new span in
  `attempts`.

### Unknown formats

If no extractor finds anything, the result stays as it is today: one `generic`
observation named `unrecognized-log-format`, now marked `boundary: "unknown"`.
Vitest logs land here until a Vitest extractor exists. That is a separate
feature and is out of scope.

## Review questions answered

| Question | Answer |
| --- | --- |
| What defines a failure block? | A framework's own structure, inside a region for that framework |
| Where does it start? | The header line, as an original line number |
| Where does it end? | The framework's end marker, as an original line number |
| Unrelated output? | Stays outside the span and cannot decide a verdict |
| Multiple failures? | One observation each, with independent spans and evidence |
| Setup and teardown? | Recorded in `phase`. Captured output is kept in `contextSpans` |
| Retries? | One observation per test, with one span per attempt in `attempts` |
| Incomplete logs? | `boundary: "truncated"`, never presented as complete |
| Unknown frameworks? | `boundary: "unknown"`, with no framework specific extraction |

## Compatibility

- **JSON:** only new optional fields are added, so `schemaVersion` stays at 1.
  Each result gains `extraction`, `evidenceLocation`, `unattributedSignals` and,
  when `UNVERIFIED`, `abstainReason`. `docs/json-output.md` is updated.
- **Behavior does change.** Result counts and some test names will change, and
  fewer signals will appear. This is the purpose of the work, but it must be
  described in the release notes.
- **History:** JUnit ingestion does not use `parseLog`, so it is unaffected. The
  database schema does not change.
- **LLM step:** receives narrower text. The Jev comparison stays valid only if
  it runs against `85d34e2`.
- **Labeled dataset:** `classifyWithRules` keeps its signature, and text with no
  `extraction` behaves as it does today, so the 13 rule matches stay comparable.

## Acceptance criteria

The 103 existing tests must keep passing. None may be weakened to fit the new
parser. If an existing test encodes the old behavior, the change must be
explained individually.

### Boundaries

- Evidence stops at the correct end line for each framework.
- A later passing test is not included.
- Text after the pytest summary is not attached to the last failure.
- Text after the Playwright count lines is not attached to the last item.
- Multiple failures keep separate spans and evidence.
- A log that ends mid failure is `truncated`.
- Captured output is in `contextSpans`, not in `rawText`.

### Detection

- Playwright output containing `●` lines is not read as Jest.
- Unknown formats stay unknown.
- `124) echo ...` and similar shell lines are not failures.
- `Console` and `Validation Warning` blocks are not failures.
- `_ _ _ _` separators are not headers.
- A short header such as `_ ERROR collecting ... _` is recognized.
- `FLAKES` entries and repeated summary entries create no extra observations.
- A session nested inside a failure creates no extra observations.

### Attribution

- A signal outside the primary evidence never changes the verdict.
- Adding or removing `unattributedSignals` never changes any verdict.
- A match only in `contextSpans` gives `UNVERIFIED` with `context-only-signal`.
- Unknown and truncated observations give `UNVERIFIED` with their own reasons.
- Every rejected block appears in the diagnostics with a line and a reason.

### Traceability

- Every observation from `parseLog` has `startLine` and `endLine`.
- Cleaning any log keeps its line count, including logs with a byte order mark.
- Cleaning the original lines in a span reproduces the observation's text.
- `evidenceLocation` points at a line inside the span.

### Negative matching (step 3, listed here so it is not forgotten)

- `ModuleNotFoundError` and `FileNotFoundError` do not trigger DNS detection.
- A shell command containing `out of memory` does not trigger an OOM verdict.

Test fixtures will be small excerpts, checked by hand for personal data. The 49
raw logs are not committed.

## Expected effect on the six signals

These are predictions to be tested, not results.

| Signal | Expected after steps 1 and 2 |
| --- | --- |
| `sentry` constraint | Gone: the line is after the failure region |
| `n8n` ECONNRESET | Gone: the line is after the Playwright count lines |
| `airflow` socket hang up | Becomes an unattributed signal (decision 1) |
| `n8n` out of memory | Becomes an unattributed signal (decision 1) |
| `pytest` DNS | **Remains** until the rule is fixed in step 3 |
| `grafana` locator | **Remains** until the rule is fixed in step 3 |

## How success is measured

Zero false signals is not the target, because flagging nothing achieves it.
Precision and recall are reported together:

- correct, false and missed environment signals
- `UNVERIFIED` outcomes
- invalid failure blocks, duplicates, and `●` lines dropped
- framework detection and failure count accuracy
- processing time

Precision and recall need reviewed labels for the 49 logs, which do not exist
yet. "Cause unknown" is a valid label. Results are then checked on a fresh set
of logs not used during this work.

## Implementation order

Each step is small, reviewed separately, and keeps all tests passing.

1. Add the types, the line count guarantee and the byte order mark fix.
2. Add acceptance tests, using fixtures from reviewed excerpts.
3. pytest extractor.
4. Jest extractor.
5. Playwright extractor.
6. Merge step, duplicate removal and unknown handling, then remove the old
   detection order.
7. CLI and JSON output, and docs.
8. Run the 49 logs and compare against the saved baseline.

## Decisions

### 1. Signals without a reliable failure association cannot decide a verdict

Approved. When `boundary` is not `complete`, or a match is outside the primary
evidence, the result stays `UNVERIFIED` and the match is listed separately.
Two kinds of evidence are kept strictly apart:

- `failureEvidence`: extracted evidence associated with a recognized failure.
- `unattributedSignals`: recognized patterns with no reliable association.

`unattributedSignals` is output only. The classifier never reads it, and a test
enforces that. The CLI explains why each such signal was not used.

`truncated` is treated the same way as `unknown`. The start of the block is
known but its end is not, so the tool cannot establish that everything up to the
end of the log belongs to that failure.

The accepted cost: a short pasted log containing `ECONNRESET` no longer gets a
verdict, and recall on unsupported formats drops. The evidence stays visible.

### 2. Captured output alone cannot decide a verdict

Approved. Captured output is preserved in `contextSpans`, and a match found only
there goes to `unattributedSignals`. Captured logs often contain errors that were
handled and did not cause the failure.

This does not claim that all captured output is irrelevant. A framework may
explicitly tie captured output to a failed assertion. That possible exception
needs its own design and is not part of this work.

### 3. The 49 logs are labeled before implementation

Approved. Labeling first prevents expected improvements from influencing the
ground truth. `UNVERIFIED` is a legitimate label, and logs are not forced into a
definite category. Labels separate confirmed application regressions, confirmed
environment failures, and insufficient evidence. A failure caused by setup, such
as a missing dependency, can be environmental without being intermittent.

## Additional requirements from review

### Evidence provenance

Every signal that influences a verdict is traceable to its original lines, so
"why was this classified as an environment signal?" is answered with the exact
evidence and its location, not only a rule name. `evidenceLocation` holds the
line range of the match, inside `extraction.span`. Each `alsoMatched` entry and
each unattributed signal carries its own location too.

### Rejected evidence is reported, not silently dropped

Extraction also returns diagnostics listing everything it declined to treat as a
failure: the line number, the text, and the reason (for example
`jest-bullet-outside-fail-context`, `jest-console-block`, or
`pytest-header-outside-failure-section`). The comparison run reports their count
and location, so a parser improvement cannot quietly hide a real failure. This is
diagnostic data, not necessarily permanent user-facing output.

### Parser uncertainty stays separate from classification uncertainty

Both can end in `UNVERIFIED`, but they mean different things, so each `UNVERIFIED`
result carries a reason:

| `abstainReason` | Kind | Meaning |
| --- | --- | --- |
| `boundary-unknown` | Parser | No failure structure was recognized |
| `boundary-truncated` | Parser | The block's end could not be established |
| `context-only-signal` | Classification | A rule matched only in captured output |
| `no-rule-matched` | Classification | The failure was extracted, but no rule matched |

## Out of scope

- Rule changes and new signatures (steps 3 and 4 of the plan)
- A Vitest extractor
- Job level failures with no test, such as a spot instance interruption. These
  stay a known recall gap. GitHub's `##[error]` lines may be a good basis later.
- Using a runner's own `flaky` status
- History schema changes and re-analysis of stored labels
- Committing the 49 raw logs
