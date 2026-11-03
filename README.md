# flaky-finder

A small, auditable rule engine that reads a CI test-failure log and reports,
for each failure, one of: `ENVIRONMENT_SIGNAL_DETECTED`, `SUSPECTED_REGRESSION`,
or `UNVERIFIED` — with the exact log line as evidence, and an explicit
statement of what that evidence does and doesn't establish.

**This is not a flaky-test detector.** It cannot tell you a test is actually
intermittent — nothing can, from a single log. What it does is the narrower,
honest thing: identify known non-product failure signatures (network resets,
timeouts, stale DOM elements, DB lock contention, ...) without ever
pretending that identifying a signature proves the test is flaky, or that
its absence proves a real bug.

## The problem

Every team with a CI pipeline has the same recurring, unglamorous moment: a
test fails, and someone decides "is this real, or just flaky — can we
merge?" by eyeballing a stack trace and re-running the job. That triage is
repetitive, inconsistent between people, and leaves no record of *why* a
failure was waved off.

## Why not just paste the log into an AI assistant?

You can, and it will give you a confident-sounding answer. The actual
difference isn't that an assistant *can't* express uncertainty — it can.
The difference is that here, uncertainty is a **fixed part of the tool's
contract**, not something that depends on how the prompt was worded that day:

- **Deterministic by default.** The rule engine is plain code: identical
  input and rule set produce identical output, every time — the LLM step is
  optional and off unless you configure it.
- **Evidence over inference.** Every verdict cites the exact matching line.
  That's an observation you can review, not a claim you have to trust.
- **It is structurally not allowed to overclaim.** `ENVIRONMENT_SIGNAL_DETECTED`
  means "this specific signature is present in the text" — not "this test is
  flaky." A failure matching nothing gets `UNVERIFIED`, which is a correct,
  common, and intentional outcome, not a fallback to be minimized.

The optional LLM fallback (any OpenAI-chat-compatible open-weight-model
endpoint — Groq, Ollama, OpenRouter, ...) only runs on the residual cases the
rules don't recognize, and is held to the same contract: its
`SUSPECTED_REGRESSION` verdict is capped at low confidence in code, not just
by asking the model nicely.

This carries over the grounding discipline behind
[`camelid-evals`](https://github.com/beinghumantester/camelid-evals): never
let a plausible-sounding claim stand in for cited evidence, and never round
insufficient evidence up to a confident answer.

## What each status means, exactly

- **`ENVIRONMENT_SIGNAL_DETECTED`** — a configured rule matched a known
  non-product signature in the supplied log text. Nothing more.
- **`UNVERIFIED`** — the available rules did not establish a supported
  classification for this failure. This is a correct, common outcome, not
  a weaker version of the other two.
- **Neither status establishes the root cause.** Neither establishes
  whether the test is actually intermittent. A signal is a lead to check,
  not permission to retry, ignore, or dismiss a failure — if you wire this
  into CI, that policy belongs in your own gating logic, not assumed from
  this tool's output (see the Roadmap's "advisory-only" note).

The `signature-match: exact/strong/weak` value next to a rule-based result
is **not a confidence score** — rule matching is plain string/regex
presence-or-absence, so there's no calculation behind a number, and
labeling it "confidence" would claim one exists. It describes how
unambiguous the matched text itself is as a signature: `exact` for an error
code essentially unique to one cause (`ECONNRESET`, `EADDRINUSE`), `strong`
for a specific but slightly more interpretive phrase, `weak` for something
looser. Only the optional LLM step reports an actual `confidence` — its own
stated confidence in its classification, which is a different, legitimate
use of the word (and is capped at `low` for `SUSPECTED_REGRESSION`
in code, not just by asking the model nicely). Note what the cap does and
doesn't mean: `low` confidence means the model itself is uncertain. It does
**not** mean a `medium`-confidence or rule-based result is "well-grounded" —
grounding comes from the cited evidence line being real and relevant, which
is yours to check, not something either number certifies.

## Prior art — this is a crowded space, and worth knowing before you adopt this

Two existing projects do substantially more than this one:

- **[FlakyRadar](https://github.com/nhan4013/flakyradar)** — a self-hosted
  platform with real flip-detection (the same commit passing *and* failing —
  actual proof of non-determinism, scored with a Wilson interval), AI
  root-cause clustering, a sandboxed diagnostic agent, and a multi-tenant
  dashboard.
- **[ai-flake-sleuth](https://github.com/deghosal-2026/ai-flake-sleuth)** — a
  PyPI package with 15 log parsers across 12 frameworks and 5 languages,
  cross-run correlation, and LLM response caching.

If you need an actual flaky-test *detection and tracking* system, start
there — they have real run-history evidence, which this project does not.
flaky-finder's only reason to exist alongside them is narrower: a minimal
reference implementation of **separating "what the log shows" from "what a
human might infer from it,"** small enough to read start to finish in one
sitting. If that discipline is useful to you as a standalone building block
— or you want to see exactly where that line gets drawn — this is for you.
If you need the full platform, use the projects above.

## Usage

Requires **Node.js 22.5 or newer** (see [Node.js version](#nodejs-version)).

```bash
npm install
npm run cli -- analyze fixtures/pytest-sample.log
```

```
Parsed 2 failure(s) from fixtures/pytest-sample.log
LLM fallback: disabled (rules-only mode)

🟡 ENVIRONMENT_SIGNAL_DETECTED  (signature-match: exact, via rule)
   test: test_fetch_user_retries
   evidence: E       requests.exceptions.ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))
   why: The connection was reset mid-request (...). This is a network signature — it can occur for several different reasons, and the log alone does not establish which one, or whether the test is actually intermittent. Treat this as a lead to check, not a confirmed diagnosis.

⚪ UNVERIFIED  (none verdict confidence, via none)
   test: test_discount_calculation
   why: No known failure signature matched. This log alone does not establish whether the failure is caused by a product defect, the test itself, or the environment. Rerun history and code review may provide additional evidence, though neither is guaranteed to resolve it.

Summary: {
  ENVIRONMENT_SIGNAL_DETECTED: 1,
  SUSPECTED_REGRESSION: 0,
  UNVERIFIED: 1
}
```

Also bundled: `fixtures/jest-sample.log`, `fixtures/playwright-sample.log`, and
`fixtures/github-actions-pytest.log` (the pytest sample as GitHub Actions
serves it: timestamps, ANSI colors, CRLF line endings).

`flaky-finder <file>` (without `analyze`) still works. Run
`flaky-finder --help` for every command, and `flaky-finder --version` for
the version. Unknown or misspelled flags are an error (exit code 2), never
silently ignored.

### Raw CI logs: colors and timestamps are stripped first

GitHub Actions and GitLab force colored output, and logs downloaded from
GitHub Actions prefix every line with a timestamp. Before parsing,
flaky-finder removes ANSI escape codes, GitHub Actions-style
`2026-11-03T05:27:43.1234567Z ` line prefixes, and `\r\n` line endings
(`src/log-cleaning.ts`), so you can feed it a log exactly as CI produced it.
JUnit failure text gets the same ANSI stripping. Other CI-specific prefixes
(for example GitLab section markers) are not handled yet.

### Machine-readable output (`--json`)

```bash
npm run cli -- analyze fixtures/pytest-sample.log --json
```

Prints exactly one JSON object to stdout, for scripts and CI steps (for
example a PR-comment action) to consume instead of scraping the text output:

```json
{
  "schemaVersion": 1,
  "tool": { "name": "flaky-finder", "version": "0.1.0" },
  "input": "fixtures/pytest-sample.log",
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
      "evidenceLine": "E       requests.exceptions.ConnectionError: ...",
      "explanation": "...",
      "source": "rule",
      "alsoMatched": []
    }
  ],
  "summary": { "ENVIRONMENT_SIGNAL_DETECTED": 1, "SUSPECTED_REGRESSION": 0, "UNVERIFIED": 1 }
}
```

`summary` always contains all three verdicts (zero-filled). `confidence`
means the same as in the text output: a match strength for rules, the
model's own confidence for the LLM step. `history ingest`, `show`, and
`report` also accept `--json`. `schemaVersion` changes only if a field is
removed or changes meaning; new fields can be added without a bump, so
ignore fields you don't recognize. The exit code is 0 whatever the verdicts
are: this output is advisory, and gating on it is your decision.

**Full contract:** every field of every `--json` output, when it's present,
and the compatibility and exit-code rules are in
[docs/json-output.md](docs/json-output.md). Tests in `tests/cli.test.ts`
fail if a field name changes by accident.

### Custom rules (`FLAKY_FINDER_RULES_FILE`)

Add your own team's failure signatures, such as a known-unreliable internal
host, without forking `src/rules.ts`:

```json
{
  "rules": [
    {
      "id": "internal-mirror-down",
      "category": "network",
      "verdict": "ENVIRONMENT_SIGNAL_DETECTED",
      "matchStrength": "exact",
      "pattern": "artifacts\\.corp\\.example\\.com.*(503|ECONNRESET)",
      "flags": "i",
      "explanation": "The internal artifact mirror was unreachable ({line})."
    }
  ]
}
```

```bash
FLAKY_FINDER_RULES_FILE=team-rules.json npm run cli -- analyze ci.log
```

- **Fields:** `id` (lowercase kebab-case, unique, and not the same as a
  built-in rule id), `category`, `verdict`, `matchStrength`
  (`exact`/`strong`/`weak`) and `pattern` (a JavaScript regex as a string)
  are required. `flags` is optional (default `"i"`; only `i`, `m`, `s` and
  `u` are allowed, because `g` and `y` make a regex stateful). `explanation`
  is optional; `{line}` in it is replaced with the matched evidence line.
- **Verdicts:** only `ENVIRONMENT_SIGNAL_DETECTED` or `UNVERIFIED`, the same
  as the built-in rules. No rule can claim `SUSPECTED_REGRESSION` from text
  matching alone.
- **Precedence:** custom rules are checked **before** the built-ins, in file
  order, and the first match decides the verdict, because a team's own
  signature is usually more specific than a generic one. A built-in rule
  that also matched is still listed in `alsoMatched` (see
  [How rules are evaluated](#how-rules-are-evaluated)).
- **Multi-line patterns:** with the `s` flag a pattern can match across
  lines. The evidence is then exactly the text it matched (which can
  contain line breaks), never surrounding log text.
- **Same contract as built-ins:** every custom match still cites its
  evidence line and gets the same "not a confirmed diagnosis" caveat. Output
  marks it as custom (`via custom rule <id>`, or `"ruleOrigin": "custom"` in
  JSON).
- **Fails loudly:** a missing file, invalid JSON, a missing field, a bad
  regex or a disallowed verdict exits with code 1 and names the file and
  rule index. A bad file never means "zero rules".
- Rules are data, not code: loading a rules file never executes anything.
  A regex can still be slow on a large log if it's written badly
  (catastrophic backtracking), so keep custom patterns simple.
- **Known gap:** `history ingest` does **not** use custom rules yet. History
  stores the built-in `RULESET_VERSION` with every piece of failure evidence,
  and that number says nothing about a team's custom rules. Supporting them
  needs a schema change to record which custom ruleset was used, so it's
  deliberately left out for now, not forgotten.

### How rules are evaluated

1. **Every rule is checked** against each failure, custom rules first (in
   file order), then the built-ins (in `src/rules.ts` order).
2. **The first matching rule decides the verdict.** Built-ins are ordered
   most specific first: an exact error code like `ECONNRESET` before a
   loose phrase like `Target closed`. There is no scoring: precedence is
   only list order, so the result is predictable and easy to audit.
3. **Nothing that matched is hidden.** Every other matching rule is listed
   with its own evidence line, as `also matched (did not decide the
   verdict)` in the text output and `alsoMatched` in JSON.
4. **A co-occurring assertion is surfaced too.** If the winning rule found
   an environment signature but the log also has an assertion mismatch
   (`AssertionError`, `expect(...).toBe`, ...), the explanation quotes it
   and says the signature doesn't rule it out.

Example: a log with both a connection reset and a timeout is reported as
`network-reset` (it comes first), with `timeout-exceeded` and its line
under `alsoMatched`. Neither one establishes the cause: they are two
observations to check. `tests/rules.test.ts` and
`tests/custom-rules.test.ts` cover these cases.

History ingestion records only the deciding rule per failure for now, not
`alsoMatched`.

### Failure signature groups

A single CI run can produce many failures that all matched the same rule —
a shared database outage showing up as 24 separate `db-contention` results,
say. Investigating 24 separate failures one at a time when they share a
signature is wasted effort, so `analyze` also reports a read-only summary
grouping its own results by which rule decided them.

**What this does and does not establish.** A group means "these failures
matched the same rule" — that is a fact already sitting in the per-failure
results above it; grouping doesn't add a new classification or inference on
top. It does **not** mean "these failures share one real-world cause":
independent, unrelated failures can trivially produce the identical
signature (two separate network blips on the same day), and a single real
incident can just as easily produce several different signatures (a DB
outage causing one test to time out and another to see a connection
reset). Every group states this explicitly, not just the ones that look
surprising — the same discipline as `ENVIRONMENT_SIGNAL_DETECTED` itself.

```
Failure signature groups (same rule matched more than once — see limitation below):
  3x network-reset  [network, exact]  (3 test(s) affected)
     - test_checkout_flow: E       requests.exceptions.ConnectionError: ...
     - test_checkout_flow_retry_1: E       requests.exceptions.ConnectionError: ...
     - test_inventory_sync: E       requests.exceptions.ConnectionError: ...
  This group reflects failure observations that matched the same rule — a shared
  classification signature, not a confirmed shared root cause. ...
```

**Rules:**

- **Grouped by `ruleId` + `ruleOrigin`.** A custom rule can never share an
  id with a built-in (`custom-rules.ts` rejects that when the rules file is
  loaded), but grouping keys on both anyway rather than relying on that
  upstream check to stay correct.
- **Counts failure *observations*, not tests.** `occurrenceCount` is how
  many failures matched; `affectedTestCount`/`affectedTestIds` is how many
  *distinct* tests that covers — they differ when the same test produced
  more than one observation, e.g. a retry-plugin duplicate (see the JUnit
  parser's documented handling of that case).
- **`matchStrength: "weak"` rules are excluded by default**, not because a
  weak match is wrong, but because grouping on a loose, generic signature
  — or, for a custom rule, a **self-declared** "weak" that nothing here
  independently verifies — is the easiest way for this feature to
  manufacture the appearance of a pattern that isn't really there. Pass
  `--include-weak-groups` to see them too; nothing is ever removed from the
  ungrouped results either way.
- **A rule that matched only once is not a group.** It's already visible in
  the normal per-failure output.
- **Grouping never changes a result.** `observations` holds the exact same
  objects that appear in the top-level results; verdicts, evidence and
  explanations are untouched.
- **The text output shows up to 3 evidence lines per group**, plus a count
  of how many more there are — `--json`'s `observations` array always has
  all of them.

**Deliberately not implemented, and not planned without more evidence
first:** normalizing/fuzzing evidence text to group near-duplicate (not
identical) errors, and any similarity- or LLM-based clustering across
*different* rules. Both require judgment calls this project isn't willing
to make without a labeled dataset to validate against — see the Roadmap.
This feature is a grouping of existing, already-trusted classifications; it
is explicitly not a root-cause or incident-correlation engine.

### Node.js version

flaky-finder declares `node >= 22.5.0`. Node.js 18 and 20 are both
end-of-life ([Node.js releases](https://nodejs.org/en/about/previous-releases)),
so supporting them isn't a goal. The one feature that really needs 22.5 is
history tracking, which uses the built-in `node:sqlite` module
([added in v22.5.0](https://nodejs.org/api/sqlite.html)). That module is
loaded only when a `history` command runs, so on a Node.js without it, the
command exits with a clear message instead of a stack trace, and `analyze`
doesn't depend on it at all.

### Optional: enable the LLM fallback

```bash
# e.g. a free Groq API key (serves open-weight models — default here is OpenAI's GPT-OSS 20B)
FLAKY_FINDER_API_KEY=gsk_your_key_here npm run cli -- fixtures/pytest-sample.log
```

Without a key, flaky-finder stays in rules-only mode and reports `UNVERIFIED`
for anything it can't place, rather than silently falling back to a
dependency it doesn't have.

### Run the test suite

```bash
npm test           # run all tests
npm run coverage   # run tests with a c8 coverage report (HTML in coverage/)
npm run lint       # ESLint
npm run format     # Prettier
```

## Limitations — what this tool does NOT establish

Stated plainly, because the whole point of this project is not overclaiming:

- **A matched signature is not proof of flakiness.** A timeout caused by a
  slow CI runner and a timeout caused by a genuine regression that never
  renders the awaited element produce the *exact same error text*. The rule
  engine reports the signature either way and says so explicitly — it does
  not and cannot resolve which one happened.
- **Every verdict above still comes from a single log.** Historical
  tracking (see that section below) adds a separate, evidence-based
  assessment across multiple ingested runs — but it requires you to ingest
  JUnit XML reports over time; without that, there is still no run history,
  and FlakyRadar's flip-detection remains the more complete version of this
  idea.
- **Multi-framework support is best-effort.** The parser extracts a test
  name and failure body; it does not yet distinguish a first failure from a
  retry-that-passed, a skip-after-setup-failure, or a failure caused by a
  different test. Treat each framework's parser as "handles the common
  case," not an exhaustive model of that tool's output.
- **The test suite checks the rules behave as written, not that they're
  right.** A passing suite means the regexes match what they were built
  to match, including the adversarial case where a matching signature masks
  a real regression, a documented precedence rule for overlapping matches
  (and that a co-occurring, lower-precedence observation is surfaced rather
  than silently dropped), basic robustness (empty input, truncated input,
  determinism), and the LLM step's own constraint-enforcement logic
  (`tests/llm.test.ts` — a model can't push `SUSPECTED_REGRESSION` past low
  confidence, an unrecognized verdict string can't pass through, malformed
  output throws instead of fabricating a result). It is not a validated
  accuracy benchmark against labeled real-world failures — there isn't one
  yet.
- **A regex can match in a misleading context.** Every rule matches on
  literal text — if a log happens to contain one of these strings outside
  its usual meaning (a comment, a quoted example, unrelated log noise), the
  rule still fires. This is an inherent risk of text-pattern matching, not
  something this version tries to disambiguate away; it's the same reason
  every match is required to cite its exact evidence line, so a human can
  immediately see if that happened.
- **Not every open-weight model is a drop-in LLM fallback.** Verified while
  building this: a reasoning/"thinking" model (Qwen3) combined with forced
  JSON output (`response_format: json_object`) through Ollama never
  returned within a 2-minute window, uncapped even by `max_tokens` — a real
  conflict between grammar-constrained decoding and a model's internal
  `<think>` phase, not something fixable client-side. A plain instruct
  model (Llama 3.2/3.1) hits none of this and returns in seconds. If you're
  running fully local, prefer a non-reasoning model for this specific
  endpoint shape.

## Historical tracking

Everything above comes from a *single* log and can never establish actual
intermittency — the strongest real evidence for flakiness is the same test
passing and failing on the same commit, which needs run history. Historical
tracking adds that, as a **separate axis from the log-level verdict, never a
replacement for it**. A test can have an `ENVIRONMENT_SIGNAL_DETECTED`
verdict on one run AND an `INTERMITTENCY_OBSERVED` historical assessment —
the verdict describes what that one log shows; the assessment describes
what the recorded run history shows. Never conflate them: `UNVERIFIED` isn't
"passed," and a signal isn't "flaky," no matter how much history piles up.

### Why JUnit XML, not the failure logs above

A failure log only ever tells you about failures — it cannot tell you a
test *passed*, so it cannot show a fail→pass pattern. pytest, Jest, and
Playwright can all emit [JUnit-style XML](https://junit.org/junit5/) test
reports (`--junitxml`, `--reporters=jest-junit`, `--reporter=junit`), which
record every test's outcome — passed, failed, or skipped — not just the
failures. That's the first and only ingestion format for history right now.
The existing log parsers are unaffected and still do their own job: a
failed test case's `<failure>` text is run through the same rule engine
(`classifyWithRules`) used for single-log analysis, so failure evidence in
history carries the same signature, rule id, and caveats as the CLI's
normal output — just attached to a specific recorded run instead of printed
once and discarded.

### Storage

Local SQLite, via Node's built-in `node:sqlite` (still marked experimental
on Node 22 — you'll see an `ExperimentalWarning` on stderr; that's expected
and harmless; newer Node.js versions mark it as a release candidate, see the
[Node.js docs](https://nodejs.org/api/sqlite.html)) — no new dependency, no server, no account, consistent with this
project staying local-first. Default location: `.flaky-finder/history.db`
(gitignored; override with `--db <path>` on every history command). Two
logical tables, kept deliberately separate:

- **`test_runs`** — one row per test case per ingested report: test
  identity, framework, outcome (`PASSED`/`FAILED`/`SKIPPED`/`UNKNOWN`), the
  run id, commit SHA, and optional environment id.
- **`failure_evidence`** — for `FAILED` rows only: the rule-engine verdict,
  rule id, matched evidence line, and the ruleset version that produced
  them (see `RULESET_VERSION` in `src/rules.ts`). Kept in its own table so
  that changing a rule later can never be mistaken for a change in actually
  observed test behavior — the two are tracked independently on purpose.

Duplicate detection is scoped to **`(run_id, report content hash)`, not
content hash alone.** Re-ingesting the exact same file under the exact same
`--run-id` is treated as a safe-to-retry duplicate and skipped. Two
genuinely separate runs that happen to produce byte-identical content (e.g.
two consecutive all-pass runs on the same commit) are **not** discarded as
duplicates of each other as long as they're given different `--run-id`
values — an earlier version of this scoped the uniqueness to content hash
alone, which would have silently dropped the second of two legitimate runs;
this was caught in review and fixed before it shipped. If you don't pass
`--run-id`, the CLI defaults to a timestamp, so every ingestion without an
explicit id is treated as new — pass a stable id (e.g. your CI run id) if
you want retry-safe deduplication.

Foreign keys (`test_runs.ingestion_id`, `failure_evidence.test_run_id`) are
enforced via `PRAGMA foreign_keys = ON`, set explicitly on every connection
— SQLite does not enforce declared foreign keys by default, so this has to
be turned on rather than assumed from the schema alone.

One report's worth of writes (the ingestion row, every `test_runs` row,
every `failure_evidence` row) is wrapped in a single explicit
`BEGIN`/`COMMIT`-or-`ROLLBACK` transaction — `node:sqlite`'s `DatabaseSync`
has no built-in `transaction()` helper, unlike some other SQLite drivers, so
this is done by hand in `history-ingest.ts`. A failure partway through
(a future bug, an unexpected constraint violation) rolls back everything
from that ingestion, including rows that had already been written
successfully earlier in the same call — it never leaves a half-recorded
report in the database.

Every database is stamped with a schema version (`PRAGMA user_version`),
checked on open. `openHistoryDb` refuses to open a database stamped with a
version it doesn't recognize rather than silently reading or writing it as
if the schema matched — the hook a real migration will need whenever the
schema actually changes. There is exactly one schema version so far, and no
migration logic yet, because nothing has needed one yet: this is the first
schema this project has ever shipped, so there's no earlier real database
anywhere to migrate from.

### The four historical assessments — what each one does and doesn't mean

These describe **recorded run history**, never a single log, and are
*in addition to*, not instead of, the verdicts in the section above.

- **`INTERMITTENCY_OBSERVED`** — the same test both passed and failed **on
  the same commit SHA** across recorded runs. This is real evidence of
  intermittent outcomes under comparable code. It does **not** establish a
  root cause, and does **not** rule out environment or infrastructure
  differences between those specific runs — two runs on the same commit can
  still differ in runner load, network conditions, or test order.
- **`FAILURE_REPEATED`** — every recorded run of this test failed. This is
  consistency across the runs that happened to get recorded, not proof of a
  product defect — nothing here rules out an environment problem that's
  simply present on every run seen so far (e.g. a CI runner that's
  consistently resource-starved).
- **`PASS_ONLY`** — every recorded run passed. This does not prove the test
  can never fail; it means no failure has been recorded in the history
  collected so far. A test with one day of `PASS_ONLY` history and a test
  with one year of it are reported identically — the assessment carries no
  notion of "how much" history, only "what kind."
- **`INSUFFICIENT_HISTORY`** — the most conservative label, and the
  default when nothing stronger is justified. It covers three distinct
  situations, deliberately not split into separate categories: (1) fewer
  than two non-skipped runs are recorded at all; (2) outcomes are mixed
  (some passed, some failed) but **never on the same commit** — e.g. a test
  failed on commit A and passed on commit B, which is exactly what a
  genuine fix looks like, not flakiness; (3) the commit SHA wasn't recorded
  for the runs being compared, so "same code" was never actually
  established — two runs with no commit recorded are never treated as "the
  same commit" just because neither has one.

### Known limitations of test identity

A test's history is tracked under `<framework>::<classname>::<name>`, built
from whatever JUnit XML gives you — there is no more reliable identifier
available from that format. Two consequences worth knowing before you rely
on this:

- **Reports that omit `classname`** (some minimal JUnit writers do) will
  merge any two tests that share a bare `name`, even if they're in
  completely unrelated files. This is tested and documented behavior
  (`tests/history.test.ts`'s "ambiguous test identities" cases), not a bug
  waiting to be fixed — it's an inherent limit of identifying a test from
  JUnit XML alone, the same way `parser.ts`'s log parsers only handle the
  common case for their formats.
- **`history show <name>`** matches by substring against both the test
  name and the full test id. If more than one distinct tracked test matches
  your query (e.g. the same test name under two different classnames), it
  lists all of them rather than silently guessing which one you meant —
  pass the full test id shown in that output to pin down one.

### Known limitations of the JUnit XML parser

It's a small regex-based extractor (`src/junit-parser.ts`), not a general
XML parser — same tradeoff as the log parsers in `parser.ts`. Specifically:

- **No XML namespace support.** A report using `<ns:testsuite>`/
  `<ns:testcase>` matches none of this parser's patterns and is treated as
  "not a recognized JUnit report" (`JUnitParseError`) — a loud, defined
  failure, not silently zero tests found.
- **A `<testcase>` with both `<failure>` and `<error>` elements** (unusual,
  but not invalid) uses only the first one in document order as evidence;
  a warning is recorded, the second is not silently merged or dropped from
  the warning list.
- **Duplicate `<testcase>` entries within one report** (e.g. emitted by a
  rerun/retry plugin) are not deduplicated — each occurrence becomes its
  own recorded run under the same `run_id`. If their outcomes differ, that
  can itself produce `INTERMITTENCY_OBSERVED` from a single CI job's
  internal retries, not from two independent executions — worth knowing if
  your test runner retries failing tests automatically before writing the
  report.
- **A truncated or malformed `<testcase>` block** (an opening tag with no
  matching close before the file ends) is excluded and flagged with a
  warning rather than silently miscounted — but this is a heuristic tag
  count, not real well-formedness validation.

### CLI

```bash
# Record outcomes from a JUnit XML report (bundled sample: fixtures/junit-sample.xml)
flaky-finder history ingest fixtures/junit-sample.xml --commit <sha> --run-id <id>

# Inspect one test's recorded history and its current assessment
flaky-finder history show test_fetch_user_retries

# Every tracked test, most actionable assessments first
flaky-finder history report
```

Flags on `ingest`: `--commit <sha>`, `--run-id <id>`, `--environment <id>`,
`--framework <pytest|jest|playwright|generic>` (JUnit XML doesn't self-
identify the framework; defaults to `generic`), `--db <path>`. `show` and
`report` both accept `--db <path>`; `report` also accepts
`--framework <name>` to filter. All three accept `--json` (see
[Machine-readable output](#machine-readable-output---json)). Every command explains what to do next when
no history exists yet, rather than printing an empty table.

### What's explicitly NOT in scope, even now

**No automatic retries and no merge gating.** History ingestion and
analysis are read-only with respect to your CI pipeline — this tool records
and reports, it does not re-run tests or block a PR based on what it finds.
Acting on a historical assessment (retrying a run, gating a merge, auto-
dismissing a failure) is a policy decision for whoever integrates this, and
it stays a deliberate choice a team opts into, never a default this project
ships with.

Also still out of scope: a hosted/shared database (local SQLite only — see
"Keeping history across CI runs" below), and any ingestion format other
than JUnit XML.

### Keeping history across CI runs

GitHub-hosted runners are ephemeral: a `.flaky-finder/history.db` created in
one job is gone by the next, so `history ingest` alone records almost nothing
useful in CI. [`.github/workflows/history-persistence-example.yml`](.github/workflows/history-persistence-example.yml)
shows how to keep it in the Actions cache: restore the latest copy, ingest
the run's JUnit report, then save it under a new key (a cache entry can't be
overwritten, so each run saves a new one and restores the newest by prefix).

Know its limits before relying on it (from GitHub's
[dependency caching docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)):

- **Branch scope:** a run can restore caches from its own branch or the
  default branch only. Record history on the default branch so there is one
  shared copy.
- **Eviction:** entries not accessed for 7 days are deleted, and a repository
  has a 10 GB cache limit by default. If nothing runs for a week, history
  starts over.
- **Concurrent runs:** two overlapping runs restore the same old copy, and
  whichever saves last wins, so the other run's ingestion is lost. The
  example uses a `concurrency` group to run one at a time.

The cache is the simplest option, not a durable store. If you need history
that never expires or is shared across branches, keep the db somewhere you
control (for example an artifact store or a storage bucket). A hosted
database is still out of scope.

## Data handling and privacy

CI logs and test reports can contain internal URLs, user IDs, request
payloads, environment variables and credentials. Here is exactly where
flaky-finder sends or keeps that text.

**`analyze` (rules only, the default):** reads the log locally and prints
results. Nothing is stored or sent anywhere. The output (text or `--json`)
quotes evidence lines from your log, so wherever you print or upload it
(CI logs, PR comments) can expose what those lines contain.

**The optional LLM fallback sends log text to a third party.** It runs only
when `FLAKY_FINDER_API_KEY` is set, and only for failures no rule matched.
For each of those, up to the first **4,000 characters** of the failure's
text go to the endpoint in `FLAKY_FINDER_BASE_URL` (Groq by default).
That text is not redacted. If your logs can contain secrets or customer
data, either leave the key unset or point `FLAKY_FINDER_BASE_URL` at a
model you run yourself (for example Ollama, see `.env.example`).

**`history ingest` stores a summary, not the report.** In
`.flaky-finder/history.db` it keeps:

- per report: a SHA-256 hash of its content, the run id, commit SHA,
  environment id, framework, the report's file path, and the time;
- per test case: test name, classname, outcome, and the same run details;
- per failed test only: the verdict, rule id, ruleset version, the
  **matched evidence line**, and the explanation (which quotes that line).

The full report and full failure text are **not** stored. The evidence line
is still raw log text, though, and can contain anything that line
contained.

**Retention and deletion:** there is no automatic expiry. History is kept
until you delete it. To delete everything, delete the database file
(`.flaky-finder/history.db`, or your `--db` path). It's gitignored by
default, so it isn't committed by accident. Deleting individual runs or
tests isn't supported yet.

**If you use the cache example workflow**, the database is uploaded to the
GitHub Actions cache for your repository. It's evicted after 7 days without
access ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)).
Treat it like any other CI artifact that can contain log text.

## Supported CI tools today

pytest, Jest, Playwright. Adding a framework is one function in
`src/parser.ts` — PRs for Vitest, Go test, JUnit/Maven, and RSpec welcome,
along with representative sample logs.

## Roadmap

- [x] Run-history tracking (`history ingest`/`show`/`report`) — see
      "Historical tracking" above for what it does and doesn't establish.
- [ ] Advisory-only GitHub Action: comment the verdict on a failing PR check.
      **Not** auto-retry or auto-merge-block by default — a wrong or
      unresolved verdict should never silently change what CI does; a team
      can opt into stricter policy later, deliberately.
- [ ] More frameworks: Vitest, Go test, RSpec
- [ ] A small labeled benchmark of real flaky/real-bug/ambiguous failures, to
      measure false-signal and false-dismissal rates honestly instead of
      just "tests pass"
- [x] A documented CI persistence step for `.flaky-finder/history.db`
      across ephemeral GitHub-hosted runners — see "Keeping history across CI
      runs" above.
- [x] Machine-readable `--json` output (the input a PR-comment action needs).
- [x] Custom rules from a JSON file (`FLAKY_FINDER_RULES_FILE`).
- [ ] Custom rules in `history ingest` (needs a schema change; see "Custom
      rules").
- [x] Failure signature groups: `analyze` groups its own results by which
      rule decided them — see "Failure signature groups" above for what it
      does and does not establish.
- [ ] Normalized-evidence grouping (near-duplicate, not identical, error
      text) — deferred until there's a documented normalization policy and
      examples proving it doesn't merge genuinely unrelated failures (e.g.
      two different internal hostnames in the same error shape).
- [ ] Similarity- or LLM-based correlation across *different* rules (e.g.
      guessing that a DNS failure and a timeout are one outage) — deferred
      until there's a labeled, independently-verified multi-failure dataset
      to measure it against, same reasoning as the single-failure
      labeled-benchmark item above. Grouping failures that already share a
      rule needed no such dataset; inferring a link between failures that
      *don't* is a materially stronger claim and needs one.
- [ ] Cross-run incident correlation (the history-tracking equivalent of
      failure signature groups, across `failure_evidence` rows instead of
      within one `analyze` run) — not started.

## Contributing

Contributions are welcome — new rules, new framework parsers, and sample
logs especially. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
