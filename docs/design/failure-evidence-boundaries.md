# Design: failure evidence boundaries

**Status:** implemented through step 7, pending review. Steps 1 to 7 are in the
code and tests; step 8, the comparison run on the 49 logs, is next. The review of
commit `a3a8e67` found the gaps that steps 6 and 7 closed, plus three in steps 3 to
5, all fixed: pytest section titles inside a block, Jest summary mode after `PASS`,
and the segment model. The review of the merged commit `6796940` found three more,
all fixed: a diagnostic message that could echo raw log content, Jest summary
matching that used only the test name (which collides across files) instead of the
suite file too, and the LLM step accepting any explanation with no check that its
claimed evidence was real — it now requires a verbatim, located quote for an
affirmative verdict. No new concepts are added unless implementation exposes a real
gap. The wider plan is in [the roadmap](../roadmap.md).
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
- One log also has a byte order mark mid-file, at the start of `airflow` line
  16099. The log appears to be joined from parts. That line keeps its timestamp
  today, so otherwise identical text differs.

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
- The `airflow` duplicates are a repeated section, a different cause from
  `FLAKES`. The `FAILURES` section at line 14713 is printed again at line 15738,
  and all 882 lines match once the byte order mark above is ignored.

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

Indentation separates nested output from real output. Across all 49 logs:

| Marker | 0 spaces | 1 space | 4 spaces |
| --- | --- | --- | --- |
| `FAIL <file>` | 13 | 15 | 18 |
| `PASS <file>` | 395 | 549 | 6 |
| `Test Suites:` | 39 | 0 | 24 |
| `Summary of all failing tests` | 13 | 0 | 0 |

Every 4 space `FAIL` line is in `jestjs/jest`.

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
  contextSpans?: ContextSpan[]; // captured output: kept, but not primary evidence
}

// A LineSpan that also carries its text, so context keeps its line boundaries
// and source location and the classifier can read it without the original log.
interface ContextSpan extends LineSpan {
  text: string;
}

// One unbroken run of primary evidence. Its text is exactly its lines.
interface EvidenceSegment extends LineSpan {
  text: string;
}

interface Failure {
  testName: string;
  framework: "pytest" | "jest" | "playwright" | "generic"; // unchanged
  rawText: string;         // derived: segments joined with "\n", for existing callers
  extraction?: FailureExtraction;
  segments?: EvidenceSegment[]; // primary evidence, in log order; the source of truth
}

// Something extraction declined to treat as a failure. Never read by the classifier.
interface Diagnostic {
  code: string;            // for example "jest-console-block"
  message: string;
  line?: number;
  text?: string;           // internal only, see "Public output"
}

// What the CLI prints. Built field by field, never by copying a Diagnostic.
interface PublicDiagnostic {
  code: string;
  message: string;
  line?: number;
}

interface ExtractionResult {
  failures: Failure[];
  diagnostics: Diagnostic[];
}

function extractFailures(log: string): ExtractionResult;

// Unchanged for existing callers.
function parseLog(log: string): Failure[] {
  return extractFailures(log).failures;
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
- **`span` and `segments` differ on purpose.** `span` covers the whole
  observation. `segments` cover only primary evidence, so captured output in the
  middle leaves a gap. Lines 100 to 150 with captured output at 120 to 140 give
  two segments, 100 to 119 and 141 to 150. A location is never calculated from
  `span.startLine` plus an offset.

## Proposed flow

```text
Raw log
  -> Clean, keeping lines one to one
  -> Run every extractor; each looks only for its own structure
  -> Merge observations in log order, then merge structurally repeated reports
  -> If there are none: one observation with boundary "unknown"
  -> Check eligibility
       Ineligible: UNVERIFIED with its abstainReason
       Eligible: match rules against primary evidence, then the LLM if no rule matched
  -> Report signals found anywhere else, without changing any verdict
```

There is no longer a step that picks one framework. Detection becomes "did this
extractor find its own structure", so a log can contain several frameworks and
checking order stops mattering. This fixes the `strapi` case by design.

Each extractor is a separate function with one contract: it receives cleaned
lines and returns observations with spans.

### When extractors overlap

Every line belongs to at most one observation. When two extractors claim
overlapping lines:

| Overlap | Result |
| --- | --- |
| One observation lies wholly inside another | The inner one is output of the outer failure. It creates no observation, its lines stay with the outer one, and a `nested-observation` diagnostic records it |
| A truncated observation starts inside another | Nested, as above. Its end was never observed, so a partial overlap cannot be established |
| Partial overlap of two complete observations, or the exact same lines | Neither boundary can be trusted. Both are kept, both are `boundary: "unknown"` and ineligible, and an `overlapping-observations` diagnostic records it |

No extractor has priority over another, so the order they run in cannot change
the result. This is the same rule already used for nested pytest sessions and
nested Jest output. Step 8 reports how often each case happens in the 49 logs.

### Responsibilities

Failure extraction and signal detection are separate steps. Extraction decides
which lines belong to a failure and never reads a rule. Signal detection runs
rules and reports what it found. Only a match in primary evidence can reach the
classifier, so a detected signal is never silently converted into a verdict.

| Information | Where it goes | Can decide a verdict? |
| --- | --- | --- |
| Failure text, including a confirmed external error | `rawText` | Yes |
| Captured stdout, stderr and logs | `contextSpans` | No |
| A session nested inside a failure | `contextSpans` when captured, otherwise `rawText` | Only as part of that failure |
| Text extraction declined to treat as a failure | `diagnostics` | No |
| A rule match in context or an unknown block | That result's `unattributedSignals` | No |
| A rule match outside every failure | Top level `unattributedSignals` | No |

Rule matches stay separate from `diagnostics` because they need a rule id and a
location, and `diagnostics` describes extraction, not rules. The top level list
aggregates every match that decided nothing, wherever it was: in context, in an
unknown or truncated block, or outside every failure. It has one entry per rule,
with the first location and a count, so a line repeated many times stays
readable. Each result also lists its own.

### Evidence eligibility

Eligibility is a hard boundary in code, not a prompt instruction. It is checked
before any rule or model can decide a verdict, and the same check applies to both.

| Evidence state | Can rules decide? | Can the LLM decide? |
| --- | --- | --- |
| Complete and attributable | Yes | Yes |
| Complete, but the cause cannot be established | Yes, by abstaining | Yes, by abstaining |
| Truncated | No | No |
| Unknown boundary | No | No |
| Unattributed signal | No | No |
| Captured output with no failure association | No | No |

- **Completeness is not certainty.** A complete block shows which lines belong to
  a failure. It does not show that the cause can be identified, so `UNVERIFIED`
  stays a valid result for an eligible failure.
- **Ineligible text is never sent to the LLM.** This ends today's behavior, where
  the start of an unknown format log is sent because it happens to be available.
  In the 49 real logs, none of the labeled evidence reached the LLM for 19 logs.
- **The block must be in place before any further LLM evaluation** on real logs.
- **Text with no `extraction`** still reaches rules as it does today. `analyze`
  always has `extraction`, because every observation from `parseLog` carries it.

### Structural and causal attribution

> Eligibility permits classification; it does not establish causality.

| Question | Answered by |
| --- | --- |
| Does this line belong to the failure block? | Parser |
| Is it primary evidence? | Extractor |
| Does it establish the cause? | Rule or LLM, with its evidence |
| Is that conclusion correct? | Evaluation against reviewed labels |

A complete block answers the first two questions only. Two things keep the third
honest:

- **The verdict claims presence, not cause.** `ENVIRONMENT_SIGNAL_DETECTED`
  means a known non-product signature is in the primary evidence. It does not say
  the signature caused the failure. When an assertion also appears, it is already
  reported next to the signal, so the reader sees both.
- **Evaluation measures it.** A signal in the right block that did not cause the
  failure counts against evidence correctness, so this kind of false positive is
  visible in the numbers, not hidden by correct boundaries.

**No `conflicting-signals` reason yet.** A conflict means two independently
supported, incompatible explanations in eligible primary evidence, with no
defensible way to choose. No such pair exists today: every rule, built in or
custom, can only return `ENVIRONMENT_SIGNAL_DETECTED` or `UNVERIFIED`, and
several environment rules agree with each other. Inventing a conflict policy
without a real incompatible pair would replace false positives with needless
abstention. The reason is added only with a defined, tested policy for a named
pair of rules or verdicts.

| Situation | Behaviour |
| --- | --- |
| Signal only in captured output | Cannot decide; `context-only-signal`, listed separately |
| Signal in primary evidence, with an assertion after it | The signal's verdict stands; the assertion is shown beside it |
| Two incompatible supported explanations | Not possible yet; needs its own policy first |

### Rule matching on segments

1. Segments are kept in original line order, and each segment's text is exactly
   its lines.
2. `rawText` is derived for existing callers. It is never used to find a location.
3. Rules match one segment at a time, so no match can cross the gap between two
   segments. That text never appeared together in the log.
4. Every match maps to a line inside one segment, and that line is checked to be
   inside the segment before it is reported.

### Cleaning

Steps run in this order, so that text compared for duplicates is already normal:
line endings, then byte order marks, then color codes, then timestamps.

- A byte order mark is removed at the start of **any** line, not only line 1.
- A byte order mark elsewhere in a line is kept.
- The raw log is never changed. Cleaning works on a copy.

### pytest

- **Region:** starts at `=== FAILURES ===` or `=== ERRORS ===`, and ends at the
  next `=== ... ===` line. Each session gets its own region.
- **Block:** starts at a `_ name _` header of any underscore length, excluding
  `_ _ _ _` separators, and ends at the next header, the end of the region, or a
  `generated xml file` line. That line is report output, not failure text. It
  ends the block but not the region or the parsing of the log.
- **Phase:** `ERROR at setup of`, `ERROR at teardown of` and `ERROR collecting`
  set the phase. Otherwise it is `call`.
- **Context:** `Captured stdout`, `Captured stderr` and `Captured log` sections
  go in `contextSpans`.
- **Other sections:** `FLAKES` and similar create no observation.
- **Nested sessions:** a `test session starts` line inside a failure region is
  output of that failure, not a new session. Its headers, sections and summary
  stay inside the outer block and create no observations. The nested session's
  own `N failed in Xs` line closes it, and only `=== ... ===` lines after that can
  end the outer region. This is a confirmed case, not a theoretical one.
- **Inside a block, only pytest's own section titles are structure.** A test's
  output can print `=== anything ===`, captured or with `-s`, and that must not
  end the block or the region. The known titles are `FAILURES`, `ERRORS`,
  `PASSES`, `XFAILURES`, `XPASSES`, `short test summary info`,
  `warnings summary`, `rerun test summary info`, `FLAKES ...`,
  `slowest N durations`, `test session starts`, and a closing line such as
  `3 failed in 1.2s`. Between blocks any title counts, because nothing but
  pytest writes there.
- **Known limitation:** captured output that contains an exact pytest title
  still ends the region. A test documents it.
- **One primary segment per block.** pytest prints captured output after the
  traceback and nothing after it, so each captured section runs to the next one
  or to the block's end. Checked on all 92 blocks in the 49 real logs: none
  resumes after captured output. The segment model allows several
  (`evidence-segments.ts`), and the rules and the LLM payload handle several.

### Jest

- **Indentation:** `FAIL`, `PASS`, `Test Suites:` and `Summary of all failing
  tests` count as markers only with 0 or 1 leading spaces, and `●` with up to 2.
  This rule is for Jest only. It is not a general rule for other runners.
- **Indentation is necessary, not sufficient.** A correctly indented line still
  has to mean a failure, as the next two rules state.
- **Context:** a `●` line counts only under a `FAIL <file>` line or inside
  `Summary of all failing tests`.
- **Not failures:** `Console` and `Validation Warning` blocks, whatever their
  indentation and whether they are under `FAIL` or `PASS`.
- **Block end:** the next `●`, `FAIL` or `PASS` line, `Test Suites:`,
  `Summary of all failing tests`, or a `##[` marker.
- **Duplicates:** a summary entry repeating an earlier entry is handled by the
  merge step below.
- **Nested output:** Jest's own repository prints inner `FAIL`, `PASS`, `●` and
  `Test Suites:` lines inside a failure, the same problem as nested pytest
  sessions. They are indented 4 or more spaces, so they stay in the outer block.
- **Risk to check:** a real failure printed with no `FAIL` line would be lost.
  The comparison run must report every `●` line this rule drops.

### Playwright

- **Item:** a number and `)`, followed by text containing `›` and a `file:line:col` location.
  A shell line such as `124) echo` matches neither.
- **Block end:** the next item, a count line such as `1 failed`, or a `##[` marker.
- **Retries:** a `Retry #N` line stays inside the item and starts a new span in
  `attempts`.
- **Load failures (known gap):** a spec file can crash on import, so no numbered
  item exists at all. In `strapi`, `TypeError: utils.asyncCurry is not a function`
  hit 4 spec files, followed by `Error: No tests found`. An item based extractor
  cannot see this. Until it has its own design, such a log stays
  `boundary: "unknown"` and must not invent a test name. It is a good candidate
  for `phase: "collection"`, with one observation per spec file.

### Duplicate removal

Identical text does not prove a duplicate. A real rerun can print exactly the
same failures, so failures are merged only when the log's **structure** shows that
a report was printed again.

| Situation | Behaviour |
| --- | --- |
| A known re-report structure, with identical blocks | Merge, and add a `duplicate-failure-block` diagnostic |
| Separate executions with visible boundaries | Keep both observations |
| Identical blocks, with no structural evidence either way | Keep both, and add a `possible-duplicate` diagnostic |

Known re-report structures:

- **pytest reprint (the observed `airflow` structure):** all three must hold:
  1. a `FAILURES` or `ERRORS` region starts after the session's closing
     `N failed ... in Xs` line,
  2. no `test session starts` line appears between them, and
  3. the reprint ends with a closing line identical to the first, including the
     duration.

  A missing session start alone proves nothing, because CI wrappers can replay or
  combine output. If any condition fails, the blocks are kept and marked
  `possible-duplicate`. The rule is checked against other logs in step 8 before
  it is widened.
- **Jest summary:** an entry in `Summary of all failing tests` repeats an earlier
  failure by definition.

What `airflow` shows: one `test session starts` at line 13902. The closing line
at 15713 is `3 failed, 18819 passed, 1269 skipped, 1 xfailed, 2 warnings in
1018.95s`. A CI wrapper then prints `Summary: Providers[...]`, the whole report
again, and an identical closing line at 16738, including the 1018.95 second
duration. There is no second session start. The excerpt must include these lines
so the test uses the structure, not only the matching text.

- **Kept:** the first occurrence, with its original spans.
- **Recorded:** each merged copy adds a diagnostic with its line and the start
  line of the copy that was kept.
- **Result:** the `airflow` excerpt gives 2 failures, not 4, plus 2 diagnostics.
- **Counts:** merging changes the number of observations, so it changes
  `occurrenceCount` in failure grouping. That field counts observations after
  merging, not real occurrences of a failure. A `possible-duplicate` pair still
  counts twice. The name is kept, because it is already documented as an
  observation count and renaming it would break consumers for no change in
  meaning.

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

- **JSON: `analyze` output becomes `schemaVersion: 2`.** The new fields are
  optional, but that only shows that old consumers can still *parse* the output.
  It does not show they will *interpret* it the same way. Failure counts, test
  identities, the meaning of `UNVERIFIED`, and the link between `rawText` and its
  location all change. `docs/json-output.md` already requires a bump when a field
  "changes meaning". Each result gains `extraction`, `segments`,
  `evidenceLocation`, `unattributedSignals` and, when `UNVERIFIED`,
  `abstainReason`. The top level gains `unattributedSignals` and `diagnostics`.
- **Versioning policy, added to `docs/json-output.md`:** `schemaVersion` describes
  the visible JSON contract of one command. A compatible optional field does not
  need a bump. Removing a field, renaming one, or changing its meaning does.
  Consumers must accept unknown optional fields and unknown `abstainReason`
  values, so a later reason code is not a breaking change.
- **History output stays at 1.** `history-cli.ts` has its own version constant
  and its output does not change. The SQLite schema version is a third, separate
  contract and does not change either.
- **The JSON page gets a full version 2 example,** and a snapshot test covers the
  top level, a result, segments and locations, `abstainReason`,
  `unattributedSignals`, diagnostics, and an empty result.
- **Behavior does change.** Result counts and some test names will change, and
  fewer signals will appear. This is the purpose of the work, but it must be
  described in the release notes.
- **History:** JUnit ingestion does not use `parseLog`, so it is unaffected. The
  database schema does not change.
- **LLM step:** receives narrower text, and only for eligible failures. The Jev
  comparison stays valid only if it runs against `85d34e2`.
- **Labeled dataset:** `classifyWithRules` keeps its signature, and text with no
  `extraction` behaves as it does today, so the 13 rule matches stay comparable.

## Acceptance criteria

The 107 existing tests must keep passing. None may be weakened to fit the new
parser. If an existing test encodes the old behavior, the change must be
explained individually.

Known case: `a truncated log (cut off mid-line) still matches a signature` in
`tests/rules.test.ts` calls `classifyWithRules` on text with no `extraction`. That
path deliberately keeps today's behaviour, for JUnit text and direct callers, so
the test stays valid. Its title does not say so. In step 2 it is renamed to state
that scope, and it is paired with the attribution test where a truncated
*extracted* block gives no verdict.

### Boundaries

- Evidence stops at the correct end line for each framework.
- A later passing test is not included.
- Text after the pytest summary is not attached to the last failure.
- Text after the Playwright count lines is not attached to the last item.
- Multiple failures keep separate spans and evidence.
- A log that ends mid failure is `truncated`.
- Captured output is in `contextSpans`, not in `rawText`.
- A pytest block stops before a `generated xml file` line, and the summary after
  it is still parsed.

### Detection

- Playwright output containing `●` lines is not read as Jest.
- Unknown formats stay unknown.
- A Playwright load failure with no numbered items invents no test.
- `124) echo ...` and similar shell lines are not failures.
- `Console` and `Validation Warning` blocks are not failures.
- `_ _ _ _` separators are not headers.
- A short header such as `_ ERROR collecting ... _` is recognized.
- `FLAKES` entries and repeated summary entries create no extra observations.
- A session nested inside a failure creates no extra observations, tested for:
  - a nested session with its own failure summary
  - a nested session with both failures and errors
  - several nested sessions in one outer failure
  - captured output containing a line that looks like a pytest section marker
  - a nested session whose output is truncated, which leaves the outer block
    truncated as well
- Indented `FAIL`, `PASS` and `Test Suites:` lines do not end a Jest block.
- A correctly indented `● Console` or `● Validation Warning` is still not a failure.

### Duplicates

- A pytest reprint after the closing line, with no new session start, gives one
  failure per test, not two, with a diagnostic for each merged copy.
- The same test failing twice with identical text, in two sessions, gives two
  observations.
- Identical blocks with no structure either way are both kept, with a
  `possible-duplicate` diagnostic.
- A pytest reprint whose closing line differs, for example in duration, is not
  merged: both are kept as `possible-duplicate`.
- An observation wholly inside another creates no observation, with a
  `nested-observation` diagnostic.
- Two partially overlapping observations are both `boundary: "unknown"`, with an
  `overlapping-observations` diagnostic.
- Running the extractors in a different order gives the same result.
- A byte order mark or line ending difference does not stop a reprint from
  merging.

### Attribution

- A signal outside the primary evidence never changes the verdict.
- Adding or removing `unattributedSignals` never changes any verdict.
- A match only in `contextSpans` gives `UNVERIFIED` with `context-only-signal`.
- Unknown and truncated observations give `UNVERIFIED` with their own reasons.
- A rule match in a truncated block is an unattributed signal, never the verdict.
- Every rejected block appears in the diagnostics with a line and a reason.
- A rule match outside every failure appears in the top level
  `unattributedSignals` and changes no verdict.
- `extractFailures` and `parseLog` return the same failures.
- Unknown and truncated observations, and matches only in context, never reach the
  LLM, even with a key configured.
- An eligible failure can still end as `UNVERIFIED`.
- An LLM that is unavailable, returns invalid output or fails validation gives its
  own reason, never `insufficient-evidence`.
- A signal in the traceback with an assertion after it keeps the signal's verdict,
  and the assertion is reported beside it.
- The same error in two test blocks: each failure cites only its own lines, and
  neither picks up the other's evidence.
- Tests check what reached the classifier, not only the verdict: the exact
  segments the rules saw. A correct verdict from the wrong evidence fails the test.

### LLM outcomes and payload

These use a stubbed `fetch` and inspect the real request body, not a helper that
builds the prompt.

- Each row of the final outcome table gives its verdict and reason.
- An empty response and a response with an unexpected shape, such as no
  `choices` field, give `llm-invalid-response`.
- The explanation for a provider error does not contain the error message.
- A provider failure on one failure does not stop the others, and the exit code
  is `0`.
- With a key but no `--llm` flag, no request is made.
- The request contains only primary evidence: no full log, context, diagnostics,
  unattributed text, or error messages.
- A failure with two segments is sent as two numbered blocks, not one joined text.
- `--llm` with no key still makes the request, after a warning.
- Unknown, truncated and context-only observations make no request at all.
- The request holds at most 4000 characters of evidence.

### Privacy of output

Each case below puts a marker value in rejected text or captured output, checks
that the `extractFailures` result still has it, and checks that it never appears
in the text output, the JSON output, the failure grouping output, or an error
path's output:

- an `Authorization: Bearer` header
- a database connection string with a password
- a URL with a username and password in it
- an internal hostname
- a secret inside captured output of an eligible failure
- a provider error that echoes the request

### Traceability

- Every observation from `parseLog` has `startLine` and `endLine`.
- Cleaning any log keeps its line count, including logs with a byte order mark.
- A byte order mark is removed at the start of the file and at the start of a later
  line, and kept elsewhere in a line.
- Cleaning the original lines of each segment reproduces that segment's text.
- `evidenceLocation` points at a line inside one segment.
- A rule match **after** removed captured output reports its true original line.
- A pattern that would match only if two segments were joined is not reported.

### Properties (metamorphic tests)

Each property changes an input in a way that should not matter, and checks what
must stay the same. Each is its own named test, assigned to the step that owns it.
They compare the affected failure's verdict, evidence and reason, never the whole
JSON output byte for byte.

| Change | Precondition | Must stay the same | Allowed to change |
| --- | --- | --- | --- |
| Append unrelated text after a complete failure | The text holds no valid failure structure | That failure's verdict and evidence | Log length, top level signals |
| Insert unrelated text before a failure | Same | Identity, verdict, evidence text | Line numbers, shifted by exactly the inserted count |
| Add a captured error to a failure | The error matches a built-in rule word for word | Primary evidence and verdict | Context and unattributed signals |
| Reorder two independent failure blocks | Both blocks complete, in the same region | Each failure's result | Order and line numbers |
| Reprint a report section | It follows the reprint structure above | Number of unique failures | A diagnostic per merged copy |
| Remove a complete block's end marker | The block was `complete` before | No verdict from that block | Boundary becomes `truncated` |
| Swap one unknown log for another | Neither has failure structure | Neither gets a rule verdict | Diagnostics |
| Insert ANSI codes | Codes only, no visible text | Evidence text and line mapping | Raw input |

The most important one is the first: **adding unrelated text cannot change an
existing failure's result.**

### Excerpt regressions

Each excerpt has one test asserting the specific behaviour, not a full snapshot:
failure count, framework and test names, evidence lines, verdict or reason, and
that the original false signal is gone. Its README row lists the expected
behaviour.

### Negative matching (step 3, listed here so it is not forgotten)

- `ModuleNotFoundError` and `FileNotFoundError` do not trigger DNS detection.
- A shell command containing `out of memory` does not trigger an OOM verdict.

Test fixtures are small excerpts in `fixtures/real-excerpts/`, with their sources,
edits and expected behaviour listed in that folder's README. A person reviews all
of them in full before they are published. The 49 raw logs are not committed.

Two cases have no real example and use a cut or small made-up input: a log that
ends mid failure, and a `=== x ===` line in captured output outside a nested
session.

## Expected effect on the six signals

These are predictions to be tested, not results.

| Signal | Expected after steps 1 and 2 |
| --- | --- |
| `sentry` constraint | No longer on any failure: top level unattributed signal |
| `n8n` ECONNRESET | No longer on any failure: top level unattributed signal |
| `airflow` socket hang up | Unattributed signal on the unknown block (decision 1) |
| `n8n` out of memory | Unattributed signal on the unknown block (decision 1) |
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

The 49 logs have reviewed labels: one per log, signed off as "informed, not
blind", in the private baseline repository at tag `labels-v1`. They are per log,
not per failure, so they score log level results only. Failure level scoring
needs the matching contract in the roadmap. "Cause unknown" is a valid label. Results are then checked on a fresh set
of logs not used during this work.

## Implementation order

Each step is small, reviewed separately, and keeps all tests passing.

1. Add the types, the line count guarantee and the byte order mark fix.
2. Add acceptance tests, using fixtures from reviewed excerpts, and remove byte
   order marks at the start of any line, which step 1 missed.
3. pytest extractor.
4. Jest extractor.
5. Playwright extractor.
6. Merge step, structural duplicate handling and unknown handling, then remove
   the old detection order.
7. The eligibility check, the final outcome function, the `--llm` opt-in, the
   public output serializer, JSON version 2, and docs.
8. Run the 49 logs and compare against the saved baseline, including how often
   the 4000 character limit cuts eligible evidence.

A new field or concept is added only if it answers five questions: what problem
it solves, which component owns it, who reads it, how it is validated, and which
test proves it.

### Unfinished tests

Acceptance tests that wait for a later step use `{ todo: true }`, so the suite
keeps passing. Node runs these tests but does not count them as failures.

- Each `todo` test names its step in its title, for example `[step 3]`.
- The marker is removed in the step that makes the test pass.
- A test is marked `todo` only before its step starts. It is never marked because
  an implementation is failing it, and a regression is fixed, not marked.
- Every step's review reports the total `todo` count and the count left for the
  current step.
- A step is not complete while any of its own acceptance tests are still `todo`.

### Real-world scoreboard

Every step's review includes a table of the 13 excerpts: today's result, the
target from the excerpts README, and the result after the step, with changes
marked. Progress means wrong behaviours fixed with no correct ones broken, not a
higher pass count. A step that breaks a previously correct excerpt is not
complete, even if every test passes.

## Decisions

### 1. Signals without a reliable failure association cannot decide a verdict

Approved. When `boundary` is not `complete`, or a match is outside the primary
evidence, the result stays `UNVERIFIED` and the match is listed separately.
Two kinds of evidence are kept strictly apart:

- `failureEvidence`: extracted evidence associated with a recognized failure.
- `unattributedSignals`: recognized patterns with no reliable association.

`unattributedSignals` is output only. The classifier never reads it, and a test
enforces that. The CLI explains why each such signal was not used.

A truncated block remains visible as diagnostic evidence, but it cannot influence a
verdict. Its start is known but its end is not, so the tool cannot establish that
all the included text belongs to the failure. Any rule matches in it are reported
as unattributed signals, and the result stays `UNVERIFIED` with
`boundary-truncated`.

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

`extractFailures` also returns diagnostics listing everything it declined to treat
as a failure: the line number, the text, and the reason (for example
`jest-bullet-outside-fail-context`, `jest-console-block`, or
`pytest-header-outside-failure-section`). The comparison run reports their count
and location, so a parser improvement cannot quietly hide a real failure.
Diagnostics never change a verdict.

### Public output

Rejected text is rejected because nobody checked it, so it may hold anything,
for example `Authorization: Bearer <secret>`.

| Layer | Diagnostic fields |
| --- | --- |
| `extractFailures` result, for tests and evaluation | `code`, `line`, `message`, `text` |
| CLI text and JSON output | `code`, `line`, `message` |
| A future verbose mode | Not built. If added, its docs must warn that it can print secrets |

The CLI builds a `PublicDiagnostic` field by field in one serializer. It never
writes an internal object with `JSON.stringify`, so a new output path cannot leak
`text` by accident.

The same applies to `contextSpans` text: it is internal, and the CLI prints only
its line range.

### Parser uncertainty stays separate from classification uncertainty

Both can end in `UNVERIFIED`, but they mean different things, so each `UNVERIFIED`
result carries a reason:

| `abstainReason` | Owner | Meaning |
| --- | --- | --- |
| `boundary-unknown` | Extraction | No failure structure was recognized, or two structures claimed the same lines |
| `boundary-truncated` | Extraction | The block's end could not be established |
| `context-only-signal` | Rule engine | A rule matched only in captured output |
| `no-rule-matched` | Rule engine | The failure was extracted, but no rule matched |
| `rule-abstained` | Rule engine | A rule matched, but its signature is not enough for a verdict, as with `wall-clock-sensitive` today |
| `insufficient-evidence` | LLM response handling | The model evaluated eligible evidence and returned a valid `UNVERIFIED` |
| `llm-unavailable` | Provider integration | The provider could not be reached, returned an error, or timed out |
| `llm-invalid-response` | LLM response handling | The response was not valid JSON or had no recognized verdict |
| `llm-response-rejected` | LLM response handling | The response parsed but failed schema or evidence reference checks |

Each reason has exactly one owner, and no other component may assign it.

**One reason per result, from the last stage that ran.** The stages run in a fixed
order: eligibility, then rules, then the LLM. An ineligible observation stops at
the first stage, so it never reaches the LLM and can never also have a provider
error. When the LLM runs after `no-rule-matched` or `context-only-signal`, its
outcome replaces that reason. A context match is still listed in
`unattributedSignals`, so nothing is lost.

### Final outcome table

One function decides every `UNVERIFIED` result's reason, from this table:

| Condition | Verdict | `abstainReason` |
| --- | --- | --- |
| Boundary unknown | `UNVERIFIED` | `boundary-unknown` |
| Boundary truncated | `UNVERIFIED` | `boundary-truncated` |
| Rule matched in primary evidence | The rule's verdict | none |
| Rule matched, and its verdict is `UNVERIFIED` | `UNVERIFIED` | `rule-abstained` (the LLM does not run, as today) |
| Match only in context, LLM off | `UNVERIFIED` | `context-only-signal` |
| No rule matched, LLM off | `UNVERIFIED` | `no-rule-matched` |
| Provider timeout or connection failure | `UNVERIFIED` | `llm-unavailable` |
| Provider error response | `UNVERIFIED` | `llm-unavailable` |
| Invalid JSON | `UNVERIFIED` | `llm-invalid-response` |
| Unrecognized verdict | `UNVERIFIED` | `llm-invalid-response` |
| Wrong field types or schema | `UNVERIFIED` | `llm-response-rejected` |
| Invalid evidence reference or quote | `UNVERIFIED` | `llm-response-rejected` |
| Valid `UNVERIFIED` from the model | `UNVERIFIED` | `insufficient-evidence` |
| Valid verdict from the model | The model's verdict | none |

A provider failure and a model abstention never share a reason. After a timeout,
the model may never have read the evidence. After a valid `UNVERIFIED`, it read
the evidence and abstained.

### The evidence quote (closes the gap flagged in review of `6796940`)

A fluent explanation is not proof the model read the evidence rather than invented a
plausible-sounding one. So a verdict that claims a cause carries a check, not just a
sentence:

- `ENVIRONMENT_SIGNAL_DETECTED` and `SUSPECTED_REGRESSION` must come with a
  non-empty `evidence` field: a verbatim quote of the text that led to it. `UNVERIFIED`
  makes no causal claim and needs none.
- The quote is checked against exactly what was sent to the model (`sentBlocks` in
  `llm.ts`), **after** the 4000 character cut — never the failure's full original
  text. A quote that exists only in the part that was cut away is rejected: the model
  never saw it, so it could not have legitimately quoted it.
- Missing, empty, or unfindable: `llm-response-rejected`. The verdict is not
  downgraded to something weaker; the whole response is rejected, because a verdict
  built on a quote that cannot be verified is not more trustworthy than one with no
  quote at all.
- A verified quote is carried through to the result as `evidenceLine` and, when the
  failure had a log position, `evidenceLocation` — the same fields a rule match uses,
  so a reader does not need to know which classifier produced a result before finding
  its evidence.
- **What this does and does not prove.** A located quote proves the model's claim
  points at real text that was actually sent, not at nothing. It does not prove the
  quote means what the model says it means, or that the model's interpretation is
  correct — that still needs a human, or the labeled evaluation in step 8.

### Provider errors

- **`abstainReason` is the contract.** Code decides on the reason, never on an
  error message.
- **The explanation is a fixed sentence per reason,** for example "The classifier
  could not be reached." Today the raw error is copied into the explanation. That
  stops, because an error can contain a URL or an echoed request.
- **The detailed error is not printed by default.** A debug output for it is not
  part of this work.
- **One failure does not stop the run.** That observation stays `UNVERIFIED`, and
  the others are still analyzed.
- **Exit codes keep their current contract:** `0` when analysis finished, `1` for
  a runtime error, `2` for a usage error. Verdicts and provider failures do not
  change it. Instead, the text summary states the count, for example
  `LLM unavailable for 2 of 5 failures`, and JSON consumers count
  `abstainReason` values.

### Sending evidence to a hosted LLM

Correct attribution is not the same as safe transmission. Primary evidence can
still contain tokens, internal hostnames or customer data.

- **What is sent:** primary evidence of one eligible failure. Never the full log,
  `contextSpans`, diagnostics, unattributed signals, or ineligible observations.
- **Segments stay separate.** Each segment is sent as its own block with its
  original line numbers, and a removed gap is marked. Joining them into one
  `rawText` would let the model read text as continuous that never was, the same
  problem the rules avoid by matching per segment.
- **A causal verdict must quote real evidence.** See "The evidence quote" above.
  This is checked against the same segments, after the character limit is applied,
  not against the failure's original, untruncated text.
- **Explicit opt-in:** today an API key alone turns the LLM on. A key can be set
  for another reason, so it is not consent. The LLM step runs only with an
  explicit `--llm` flag. Without the flag, a set key prints a one-line note that
  the LLM is off.
- **The key is optional.** It is sent when set. A local endpoint such as Ollama
  can run with none. A hosted provider that needs a key and gets none returns an
  error, which becomes `llm-unavailable`, and `--llm` without a key prints a
  one-line warning first. Today the code requires a key for every endpoint.
- **Disclosure:** when the LLM runs, the CLI prints the endpoint's host before
  sending anything. The README says what is sent and to whom. It makes no
  promise about provider retention or training, because those terms are not
  verified here and can change.
- **Local option:** any OpenAI compatible endpoint works, including a local
  Ollama, for users who cannot send logs out.
- **No automatic masking,** because a scanner finding nothing does not show text
  is safe, and masking can damage the evidence.

**The 4000 character limit.** Today the first 4000 characters of `rawText` are
sent, which could cut off the assertion at the end. This is measured before it is
changed: step 8 reports how many eligible failures exceed the limit and whether
their labeled evidence falls past it. Only if it does is a selection method
designed and evaluated. Until then the limit applies per failure, after segments
are built, and a cut payload says so in the prompt.

`insufficient-evidence` is used only when the model returned a valid answer of
`UNVERIFIED`. When it never successfully evaluated the evidence, the result is still
`UNVERIFIED`, with one of the three reasons below it. The first two match
`SERVICE_FAILURE` in the frozen evaluation contract. `llm-response-rejected` is new
with contract v2 and is reported separately, because a model that invents a quote
has answered, but wrongly.

This changes one current behavior: an unrecognized verdict string such as
`DEFINITELY_FLAKY` already becomes `UNVERIFIED`, but today it looks like an answer.
It becomes `llm-invalid-response`. The verdict does not change.

## Out of scope

- Rule changes and new signatures (steps 3 and 4 of the plan)
- A Vitest extractor
- Job level failures with no test, such as a spot instance interruption. These
  get their own design in phase 3 of the roadmap and are not forced into this test
  level model. GitHub's `##[error]` lines may be a good basis.
- Using a runner's own `flaky` status
- History schema changes and re-analysis of stored labels
- Committing the 49 raw logs
