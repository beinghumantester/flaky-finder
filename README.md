# flaky-finder

flaky-finder is a small rule engine you can audit. It reads a CI test failure
log and gives each failure one of three statuses: `ENVIRONMENT_SIGNAL_DETECTED`,
`SUSPECTED_REGRESSION`, or `UNVERIFIED`. Every status comes with the exact log
line it is based on, and a plain statement of what that line does and does
not prove.

**This is not a flaky test detector.** No tool can tell you that a test is
truly intermittent by looking at a single log. What flaky-finder does is
narrower and more honest. It spots well known failure signatures that usually
come from outside the product (network resets, timeouts, stale DOM elements,
database lock contention, and so on). It never pretends that finding one of
these signatures proves a test is flaky, and it never pretends that finding
none proves there is a real bug.

## Contents

- [The problem](#the-problem)
- [Why not just paste the log into an AI assistant?](#why-not-just-paste-the-log-into-an-ai-assistant)
- [What each status means, exactly](#what-each-status-means-exactly)
- [Prior art](#prior-art)
- [Getting started](#getting-started)
- [Features](#features)
- [Historical tracking](#historical-tracking)
- [Data handling and privacy](#data-handling-and-privacy)
- [Limitations](#limitations)
- [Supported CI tools](#supported-ci-tools)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## The problem

Every team with a CI pipeline knows this moment. A test fails, and someone
has to decide whether the failure is real or just flaky, and whether it is
safe to merge. Usually that means staring at a stack trace and running the
job again. This kind of triage is repetitive, different people judge it
differently, and nobody keeps a record of *why* a failure was waved off.

## Why not just paste the log into an AI assistant?

You can, and you will get a confident answer. The real difference is not
that an assistant *cannot* express uncertainty, because it can. The
difference is that in flaky-finder, uncertainty is a **fixed part of how the
tool works**. It does not depend on how the prompt happened to be worded that
day.

- **Deterministic by default.** The rule engine is plain code. The same input
  and the same rules always produce the same output. The LLM step is
  optional and stays off unless you turn it on.
- **Evidence over inference.** Every verdict quotes the exact line that
  matched. That is an observation you can check yourself, not a claim you
  have to trust.
- **It is not allowed to overclaim.** `ENVIRONMENT_SIGNAL_DETECTED` means
  "this specific signature appears in the text". It does not mean "this test
  is flaky". A failure that matches nothing is marked `UNVERIFIED`, and that
  is a correct, common and intended result, not a fallback to be avoided.

The optional LLM fallback works with any endpoint that speaks the OpenAI chat
format and serves an open weight model, such as Groq, Ollama or OpenRouter.
It only looks at the leftover failures that the rules did not recognize, and
it follows the same rules as everything else. A `SUSPECTED_REGRESSION`
verdict from the model is capped at low confidence in the code itself, not
just by asking the model nicely.

This follows the same grounding approach as
[`camelid-evals`](https://github.com/beinghumantester/camelid-evals): never
let a believable claim stand in for real evidence, and never turn weak
evidence into a confident answer.

## What each status means, exactly

- **`ENVIRONMENT_SIGNAL_DETECTED`**: a rule matched a known signature in the
  log text that usually points away from the product itself. Nothing more
  than that.
- **`UNVERIFIED`**: the available rules could not support any
  classification for this failure. This is a correct and common result, not
  a weaker version of the other two.
- **Neither status tells you the root cause**, and neither tells you whether
  the test is truly intermittent. A signal is a lead worth checking. It is
  not permission to retry, ignore or dismiss a failure. If you plug this
  into CI, that policy belongs in your own gating logic and should not be
  assumed from this tool's output (see the "advisory only" note in the
  [Roadmap](#roadmap)).

The `signature-match: exact/strong/weak` label next to a rule result is
**not a confidence score**. Rule matching only checks whether some text is
present or not, so there is no calculation that could produce a number, and
calling it "confidence" would suggest there is one. The label describes how
clearly the matched text points to one cause:

- `exact`: an error code that almost always means one thing, such as
  `ECONNRESET` or `EADDRINUSE`
- `strong`: a specific phrase that needs a little more interpretation
- `weak`: a looser phrase with more room for a false match

Only the optional LLM step reports a real `confidence`, which is the model's
own stated confidence in its answer. That is a different and legitimate use
of the word, and it is capped at `low` for `SUSPECTED_REGRESSION` in code.
Be clear about what the cap means: `low` confidence means the model itself
is unsure. It does **not** mean that a `medium` confidence or rule based
result is "well grounded". Grounding comes from the quoted evidence line
being real and relevant, and checking that is up to you. Neither label
guarantees it.

## Prior art

This is a crowded space, and it is worth knowing about the alternatives
before you adopt this project. Two existing projects do a lot more:

- **[FlakyRadar](https://github.com/nhan4013/flakyradar)** is a self hosted
  platform with real flip detection (the same commit both passing *and*
  failing, which is actual proof of non determinism, scored with a Wilson
  interval), AI root cause clustering, a sandboxed diagnostic agent, and a
  dashboard for multiple teams.
- **[ai-flake-sleuth](https://github.com/deghosal-2026/ai-flake-sleuth)** is
  a PyPI package with 15 log parsers covering 12 frameworks and 5 languages,
  correlation across runs, and caching of LLM responses.

If you need a full system for *detecting and tracking* flaky tests, start
with those. They have real run history evidence, and this project's history
support is much simpler. flaky-finder has a narrower reason to exist next to
them: it is a minimal reference for **keeping "what the log shows" separate
from "what a person might conclude from it"**, small enough to read from
start to finish in one sitting. If that discipline is useful to you as a
building block, or you want to see exactly where that line is drawn, this
project is for you. If you need the full platform, use one of the projects
above.

## Getting started

### Requirements

You need **Node.js 22.5 or newer**. Node.js 18 and 20 have both reached end
of life ([Node.js releases](https://nodejs.org/en/about/previous-releases)),
so supporting them is not a goal.

The only feature that truly needs 22.5 is history tracking, which uses the
built in `node:sqlite` module
([added in v22.5.0](https://nodejs.org/api/sqlite.html)). That module is
loaded only when you run a `history` command. On a Node.js version without
it, the command stops with a clear message instead of a stack trace, and
`analyze` does not depend on it at all.

### Analyze a log

```bash
npm install
npm run cli -- analyze fixtures/pytest-sample.log
```

```
Parsed 2 failure(s) from fixtures/pytest-sample.log
LLM fallback: disabled (rules-only mode)

🟡 ENVIRONMENT_SIGNAL_DETECTED  (signature-match: exact, via rule)
   test: test_fetch_user_retries
   lines: 2-9 (complete, pytest-failures-section, call)
   evidence (line 7): E       requests.exceptions.ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))
   why: The connection was reset mid-request (...). This is a network signature — it can occur for several different reasons, and the log alone does not establish which one, or whether the test is actually intermittent. Treat this as a lead to check, not a confirmed diagnosis.

⚪ UNVERIFIED  (none verdict confidence, via none)
   test: test_discount_calculation
   lines: 10-17 (complete, pytest-failures-section, call)
   abstained: no-rule-matched
   why: No known failure signature matched. This log alone does not establish whether the failure is caused by a product defect, the test itself, or the environment. Rerun history and code review may provide additional evidence, though neither is guaranteed to resolve it.

Summary: {
  ENVIRONMENT_SIGNAL_DETECTED: 1,
  SUSPECTED_REGRESSION: 0,
  UNVERIFIED: 1
}
```

The project also ships with `fixtures/jest-sample.log`,
`fixtures/playwright-sample.log`, and `fixtures/github-actions-pytest.log`.
The last one is the pytest sample exactly as GitHub Actions serves it, with
timestamps, ANSI colors and Windows style line endings.

Running `flaky-finder <file>` without the word `analyze` still works. Run
`flaky-finder --help` to see every command, and `flaky-finder --version` to
see the version. An unknown or misspelled flag is treated as an error (exit
code 2) and is never silently ignored.

### Run the test suite

```bash
npm test           # run all tests
npm run coverage   # run tests with a c8 coverage report (HTML in coverage/)
npm run lint       # ESLint
npm run format     # Prettier
```

## Features

### Raw CI logs work as they are

GitHub Actions and GitLab turn on colored output by default, and logs you
download from GitHub Actions start every line with a timestamp. Before
parsing, flaky-finder removes ANSI escape codes, GitHub Actions timestamps
such as `2026-11-03T05:27:43.1234567Z`, and `\r\n` line endings (see
`src/log-cleaning.ts`). That means you can give it a log exactly as your CI
produced it. Failure text inside JUnit reports gets the same color cleanup.
Other CI specific prefixes, such as GitLab section markers, are not handled
yet.

### Machine readable output (`--json`)

```bash
npm run cli -- analyze fixtures/pytest-sample.log --json
```

This prints exactly one JSON object to stdout. Scripts and CI steps (for
example, an action that comments on a pull request) can read it directly
instead of picking apart the text output.

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

A few things worth knowing:

- `summary` always lists all three verdicts, with zero for any that did not
  occur.
- `confidence` means the same thing as in the text output: a match strength
  for rules, and the model's own confidence for the LLM step.
- `history ingest`, `history show` and `history report` accept `--json` too.
- `schemaVersion` only changes when a field is removed or changes meaning.
  New fields can be added without changing it, so simply ignore any field
  you do not recognize.
- The exit code is 0 no matter what the verdicts are. This output is
  advisory, and whether to block anything based on it is your call.

**Full contract:** every field in every `--json` output, when each one is
present, and the rules for compatibility and exit codes are described in
[docs/json-output.md](docs/json-output.md). The tests in `tests/cli.test.ts`
fail if a field name changes by accident.

### Custom rules (`FLAKY_FINDER_RULES_FILE`)

You can add your own team's failure signatures, such as an internal host
that is known to be unreliable, without forking `src/rules.ts`:

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

How custom rules behave:

- **Fields.** These are required: `id` (lowercase words joined by dashes,
  unique, and different from every built in rule ID), `category`, `verdict`,
  `matchStrength` (`exact`, `strong` or `weak`), and `pattern` (a JavaScript
  regular expression written as a string). `flags` is optional and defaults
  to `"i"`. Only `i`, `m`, `s` and `u` are allowed, because `g` and `y` make
  a regular expression remember state between matches. `explanation` is
  optional, and any `{line}` inside it is replaced with the matched evidence
  line.
- **Verdicts.** A custom rule can only produce `ENVIRONMENT_SIGNAL_DETECTED`
  or `UNVERIFIED`, just like the built in rules. No rule can claim
  `SUSPECTED_REGRESSION` from matching text alone.
- **Order.** Custom rules are checked **before** the built in ones, in the
  order they appear in your file, and the first match decides the verdict.
  A team's own signature is usually more specific than a general one. Any
  built in rule that also matched is still listed in `alsoMatched` (see
  [How rules are evaluated](#how-rules-are-evaluated)).
- **Patterns across several lines.** With the `s` flag, a pattern can match
  text that spans more than one line. In that case the evidence is exactly
  the text that matched (line breaks included), never the surrounding log.
- **Same standards as built in rules.** Every custom match still quotes its
  evidence line and gets the same "not a confirmed diagnosis" note. The
  output marks it clearly as custom: `via custom rule <id>` in text, and
  `"ruleOrigin": "custom"` in JSON.
- **Problems are reported loudly.** A missing file, invalid JSON, a missing
  field, a broken regular expression or a verdict that is not allowed all
  stop the run with exit code 1, naming the file and the position of the
  rule. A broken file never quietly turns into "no rules".
- **Rules are data, not code.** Loading a rules file never runs anything.
  A badly written regular expression can still be slow on a large log
  (this is called catastrophic backtracking), so keep your patterns simple.
- **Known gap.** `history ingest` does **not** use custom rules yet. History
  saves the built in `RULESET_VERSION` with each piece of failure evidence,
  and that number says nothing about your own rules. Supporting them needs
  a database schema change to record which custom rules were used, so this
  has been left out on purpose for now. It has not been forgotten.

### How rules are evaluated

1. **Every rule is checked** against each failure. Custom rules come first,
   in file order, followed by the built in rules in the order they appear in
   `src/rules.ts`.
2. **The first rule that matches decides the verdict.** Built in rules are
   ordered from most specific to least specific, so an exact error code like
   `ECONNRESET` comes before a loose phrase like `Target closed`. There is no
   scoring. The order of the list is the only thing that decides, which keeps
   results predictable and easy to audit.
3. **Nothing that matched is hidden.** Every other rule that matched is
   listed with its own evidence line. In the text output it appears as
   `also matched (did not decide the verdict)`, and in JSON as `alsoMatched`.
4. **An assertion failure in the same log is shown as well.** If the deciding
   rule found an environment signature but the log also contains an
   assertion mismatch (such as `AssertionError` or `expect(...).toBe`), the
   explanation quotes it and points out that the signature does not rule it
   out.

For example, a log that contains both a connection reset and a timeout is
reported as `network-reset` because that rule comes first, and
`timeout-exceeded` appears under `alsoMatched` with its own line. Neither one
proves the cause. They are two observations worth checking. The tests in
`tests/rules.test.ts` and `tests/custom-rules.test.ts` cover these cases.

For now, history ingestion records only the deciding rule for each failure,
not the `alsoMatched` list.

### Failure signature groups

A single CI run can produce many failures that all matched the same rule.
Imagine one database outage showing up as 24 separate `db-contention`
results. Looking at 24 failures one by one when they share a signature is
wasted effort, so `analyze` also prints a read only summary that groups its
results by the rule that decided them.

**What a group does and does not tell you.** A group means "these failures
matched the same rule". That fact is already visible in the individual
results above it, so grouping adds no new classification or guesswork. It
does **not** mean "these failures share one real cause". Unrelated failures
can easily produce the same signature (two separate network blips on the
same day, for instance), and one real incident can just as easily produce
several different signatures (a database outage that makes one test time out
and another see a connection reset). Every group says this explicitly, not
only the ones that look surprising. It is the same care that
`ENVIRONMENT_SIGNAL_DETECTED` itself takes.

```
Failure signature groups (same rule matched more than once — see limitation below):
  3x network-reset  [network, exact]  (3 test(s) affected)
     - test_checkout_flow: E       requests.exceptions.ConnectionError: ...
     - test_checkout_flow_retry_1: E       requests.exceptions.ConnectionError: ...
     - test_inventory_sync: E       requests.exceptions.ConnectionError: ...
  This group reflects failure observations that matched the same rule — a shared
  classification signature, not a confirmed shared root cause. ...
```

How grouping works:

- **Groups are keyed on `ruleId` and `ruleOrigin` together.** A custom rule
  can never use the same ID as a built in rule (`custom-rules.ts` rejects
  that when it loads the file), but grouping uses both values anyway instead
  of relying on that earlier check to stay correct.
- **It counts failures, not tests.** `occurrenceCount` is how many failures
  matched. `affectedTestCount` and `affectedTestIds` tell you how many
  *different* tests those failures came from. The two numbers differ when
  the same test failed more than once, for example when a retry plugin adds
  a duplicate entry (see how the JUnit parser handles that case).
- **Rules with `matchStrength: "weak"` are left out by default.** A weak
  match is not wrong, but grouping on a loose, general signature is the
  easiest way for this feature to suggest a pattern that is not really
  there. The same goes for a custom rule that calls itself "weak", since
  nothing here checks that label independently. Pass
  `--include-weak-groups` to include them. The individual results are never
  affected either way.
- **A rule that matched only once does not form a group.** It is already
  visible in the normal output for each failure.
- **Grouping never changes a result.** `observations` holds exactly the same
  objects as the main results. Verdicts, evidence and explanations stay
  untouched.
- **The text output shows up to 3 evidence lines per group**, plus a count
  of how many more there are. The `observations` array in `--json` output
  always includes all of them.

**Left out on purpose, with no plans to add without more evidence first:**
smoothing out evidence text so that similar (but not identical) errors are
grouped together, and any clustering across *different* rules based on
similarity or an LLM. Both need judgment calls that this project will not
make without a labeled dataset to check them against (see the
[Roadmap](#roadmap)). This feature groups results that are already trusted.
It is deliberately not a tool for finding root causes or linking incidents.

### Optional LLM fallback

```bash
# Off by default. --llm turns it on; a key alone does not.
# For example, a free Groq API key (Groq serves open weight models; the default here is OpenAI's GPT-OSS 20B)
FLAKY_FINDER_API_KEY=gsk_your_key_here npm run cli -- fixtures/pytest-sample.log --llm
```

Without `--llm`, flaky-finder stays in rules only mode, even when a key is
set, and says so on stderr. Anything it cannot place is reported as
`UNVERIFIED`, rather than quietly depending on a service it does not have.
The key is optional: a local endpoint such as Ollama needs none. Before you
turn this on, read what it sends in
[Data handling and privacy](#data-handling-and-privacy).

## Historical tracking

Everything above is based on a *single* log, and a single log can never
prove that a test is truly intermittent. The strongest real evidence of
flakiness is the same test passing and failing on the same commit, and that
needs a history of runs. Historical tracking adds exactly that, as a
**separate view next to the log verdict, never a replacement for it**.

A test can have an `ENVIRONMENT_SIGNAL_DETECTED` verdict on one run *and* an
`INTERMITTENCY_OBSERVED` history assessment. The verdict describes what that
one log shows, and the assessment describes what the recorded runs show.
Please never mix the two up: `UNVERIFIED` does not mean "passed", and a
signal does not mean "flaky", however much history builds up.

### Commands

```bash
# Record outcomes from a JUnit XML report (bundled sample: fixtures/junit-sample.xml)
flaky-finder history ingest fixtures/junit-sample.xml --commit <sha> --run-id <id>

# Inspect one test's recorded history and its current assessment
flaky-finder history show test_fetch_user_retries

# Every tracked test, most actionable assessments first
flaky-finder history report
```

Options for `ingest`:

- `--commit <sha>`, `--run-id <id>` and `--environment <id>` describe the run.
- `--framework <pytest|jest|playwright|generic>` sets the framework, because
  JUnit XML does not say which tool produced it. The default is `generic`.
- `--db <path>` chooses the database file.

`show` and `report` both accept `--db <path>`, and `report` also accepts
`--framework <name>` to filter the list. All three commands accept `--json`
(see [Machine readable output](#machine-readable-output---json)). When no
history exists yet, every command tells you what to do next instead of
printing an empty table.

### Why JUnit XML instead of the failure logs above

A failure log only ever talks about failures. It cannot tell you that a test
*passed*, so it can never show a test going from failing to passing. pytest,
Jest and Playwright can all write [JUnit style XML](https://junit.org/junit5/)
reports (`--junitxml`, `--reporters=jest-junit`, `--reporter=junit`), which
record the outcome of every test: passed, failed or skipped. That is the
first and only input format for history right now.

The log parsers are not affected and keep doing their own job. When a test
case in a JUnit report has failed, its `<failure>` text goes through the same
rule engine (`classifyWithRules`) used for single logs. So the failure
evidence stored in history has the same signature, rule ID and notes as the
normal CLI output. It is simply attached to a specific recorded run instead
of being printed once and forgotten.

### Storage

History lives in a local SQLite file, using Node's built in `node:sqlite`
module. That means no extra dependency, no server and no account, which fits
this project's local first approach. On Node 22 the module is still marked
experimental, so you will see an `ExperimentalWarning` on stderr. That is
expected and harmless. Newer Node.js versions mark it as a release candidate
(see the [Node.js docs](https://nodejs.org/api/sqlite.html)).

The default location is `.flaky-finder/history.db`. It is ignored by git,
and you can choose a different file with `--db <path>` on any history
command. The data is split into two tables that are deliberately kept apart:

- **`test_runs`** has one row for each test case in each ingested report:
  the test's identity, framework, outcome (`PASSED`, `FAILED`, `SKIPPED` or
  `UNKNOWN`), the run ID, the commit SHA, and an optional environment ID.
- **`failure_evidence`** is only filled in for `FAILED` rows. It holds the
  rule engine's verdict, the rule ID, the matched evidence line, and the
  version of the rule set that produced them (see `RULESET_VERSION` in
  `src/rules.ts`). It has its own table so that a later change to a rule can
  never be mistaken for a change in how the test actually behaved. The two
  are tracked separately on purpose.

**Duplicate reports.** Duplicates are detected using **the run ID and the
report's content hash together**, not the content hash alone. Ingesting the
exact same file under the exact same `--run-id` again is treated as a safe
retry and skipped. Two genuinely separate runs that happen to produce
identical files (for example, two passing runs in a row on the same commit)
are **not** treated as duplicates, as long as they have different `--run-id`
values. An earlier version used the content hash alone, which would have
silently dropped the second of two real runs. That was caught in review and
fixed before release. If you leave out `--run-id`, the CLI uses a timestamp,
so every ingestion counts as new. Pass a stable ID (such as your CI run ID)
if you want retries to be detected safely.

**Foreign keys.** The links between tables (`test_runs.ingestion_id` and
`failure_evidence.test_run_id`) are enforced with `PRAGMA foreign_keys = ON`,
which is set on every connection. SQLite does not enforce foreign keys by
default, so this has to be switched on explicitly.

**All or nothing writes.** Everything written for one report (the ingestion
row, every `test_runs` row and every `failure_evidence` row) happens inside a
single `BEGIN` and `COMMIT` (or `ROLLBACK`) transaction. The `DatabaseSync`
class in `node:sqlite` has no built in `transaction()` helper, unlike some
other SQLite drivers, so `history-ingest.ts` does this by hand. If something
fails halfway through (a future bug, or an unexpected constraint violation),
everything from that ingestion is rolled back, including rows that were
already written. You never end up with a half recorded report.

**Schema version.** Every database is stamped with a schema version
(`PRAGMA user_version`) that is checked when it is opened. `openHistoryDb`
refuses to open a database with a version it does not recognize, instead of
reading or writing it as if the schema matched. This is the hook that a real
migration will need once the schema changes. So far there is exactly one
schema version and no migration code, because nothing has needed one yet.
This is the first schema the project has shipped, so there is no older
database anywhere to migrate from.

### The four history assessments

These describe the **recorded run history**, never a single log, and they
come *in addition to* the verdicts above, not instead of them.

- **`INTERMITTENCY_OBSERVED`**: the same test both passed and failed **on the
  same commit SHA** across recorded runs. This is real evidence of
  inconsistent results on the same code. It does **not** tell you the root
  cause, and it does **not** rule out differences in environment or
  infrastructure between those runs. Two runs on the same commit can still
  differ in runner load, network conditions or test order.
- **`FAILURE_REPEATED`**: every recorded run of this test failed. That shows
  consistency across the runs that happened to be recorded. It is not proof
  of a product bug, because nothing here rules out an environment problem
  that has been present in every run so far (for example, a CI runner that
  is always short of resources).
- **`PASS_ONLY`**: every recorded run passed. This does not prove the test
  can never fail. It only means no failure has been recorded so far. A test
  with one day of passing history and a test with a year of it are reported
  the same way, because the assessment describes the *kind* of history, not
  *how much* of it there is.
- **`INSUFFICIENT_HISTORY`**: the most cautious label, and the default when
  nothing stronger can be justified. It covers three different situations,
  which are deliberately not split apart:
  1. fewer than two runs (not counting skipped ones) have been recorded;
  2. results are mixed (some passed, some failed) but **never on the same
     commit**. For example, a test failed on commit A and passed on commit
     B, which is exactly what a real fix looks like, not flakiness;
  3. the commit SHA was not recorded for the runs being compared, so "the
     same code" was never actually established. Two runs with no recorded
     commit are never treated as the same commit just because both are
     missing one.

### How tests are identified

A test's history is stored under `<framework>::<classname>::<name>`, built
from whatever the JUnit XML provides. That format offers nothing more
reliable. Two things are worth knowing before you depend on it:

- **Reports without a `classname`** (some minimal JUnit writers leave it out)
  will merge any two tests that share the same `name`, even if they live in
  completely unrelated files. This is tested and documented behavior (see
  the "ambiguous test identities" cases in `tests/history.test.ts`), not a
  bug waiting for a fix. It is a natural limit of identifying tests from
  JUnit XML alone, in the same way that the log parsers in `parser.ts` only
  handle the common case for each format.
- **`history show <name>`** searches for your text inside both the test name
  and the full test ID. If more than one tracked test matches (for example,
  the same test name under two different classnames), it lists all of them
  instead of guessing which one you meant. Use the full test ID shown in
  that output to pick exactly one.

### Limits of the JUnit XML parser

The parser (`src/junit-parser.ts`) is a small extractor built on regular
expressions, not a general XML parser. It makes the same trade off as the
log parsers in `parser.ts`. In particular:

- **XML namespaces are not supported.** A report that uses
  `<ns:testsuite>` or `<ns:testcase>` matches none of the parser's patterns
  and is rejected as "not a recognized JUnit report" (`JUnitParseError`).
  That is a loud, clear failure rather than a silent report of zero tests.
- **A `<testcase>` with both a `<failure>` and an `<error>` element**
  (unusual, but valid) uses only the first one in the document as evidence.
  A warning is recorded so the second one is not silently lost.
- **Duplicate `<testcase>` entries in one report** (for example, from a
  plugin that reruns failed tests) are not merged. Each one becomes its own
  recorded run under the same `run_id`. If their results differ, that alone
  can produce `INTERMITTENCY_OBSERVED` from retries inside a single CI job,
  rather than from two independent runs. Keep this in mind if your test
  runner automatically retries failing tests before writing the report.
- **A cut off or broken `<testcase>` block** (an opening tag with no closing
  tag before the file ends) is left out and flagged with a warning instead
  of being silently miscounted. This is based on counting tags, though, so
  it is not a full check that the XML is well formed.

### Keeping history across CI runs

GitHub hosted runners are thrown away after each job, so a
`.flaky-finder/history.db` created in one job is gone by the next. On its
own, `history ingest` therefore records almost nothing useful in CI.

[`.github/workflows/history-persistence-example.yml`](.github/workflows/history-persistence-example.yml)
shows how to keep the database in the GitHub Actions cache. It restores the
latest copy, ingests the run's JUnit report, and then saves the database
under a new key. A cache entry cannot be overwritten, so each run saves a new
one and the next run restores the newest one by matching the start of its
name.

Know its limits before you rely on it (from GitHub's
[dependency caching docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)):

- **Branch scope.** A run can only restore caches from its own branch or the
  default branch. Record history on the default branch so there is one
  shared copy.
- **Eviction.** Cache entries that are not used for 7 days are deleted, and
  each repository has a 10 GB cache limit by default. If nothing runs for a
  week, history starts over.
- **Runs at the same time.** Two overlapping runs restore the same old copy,
  and whichever one saves last wins, so the other run's data is lost. The
  example uses a `concurrency` group so that only one run happens at a time.

The cache is the simplest option, not permanent storage. If you need history
that never expires or is shared across branches, keep the database somewhere
you control, such as an artifact store or a storage bucket.

### What is deliberately out of scope

**No automatic retries and no merge blocking.** History ingestion and
analysis never change your CI pipeline. This tool records and reports. It
does not rerun tests or block a pull request based on what it finds. Acting
on a history assessment (retrying a run, blocking a merge, or automatically
dismissing a failure) is a policy decision for whoever sets this up. It
stays a deliberate choice that a team makes, never a default that this
project ships with.

Also out of scope for now: a hosted or shared database (only local SQLite is
supported, see [Keeping history across CI runs](#keeping-history-across-ci-runs)),
and any input format for history other than JUnit XML.

## Data handling and privacy

CI logs and test reports can contain internal URLs, user IDs, request
payloads, environment variables and credentials. Here is exactly where
flaky-finder sends or keeps that text.

**`analyze` (rules only, the default)** reads the log on your machine and
prints the results. Nothing is stored or sent anywhere. Keep in mind that the
output (text or `--json`) quotes evidence lines from your log, so wherever
you print or upload it (CI logs, pull request comments) can expose what those
lines contain.

**The optional LLM step sends log text to a third party.** It runs only
when you pass `--llm`: a configured key is not treated as consent. Before the
first request the CLI prints the endpoint's host on stderr. It sends, for
each failure that no rule matched and whose evidence is complete and
attributable, that failure's **primary evidence only**: up to
**4,000 characters**, as one block per evidence segment with its original line
numbers. It never sends the full log, captured output, lines extraction
rejected, or signals it could not attribute. Unknown-format and truncated
observations are never sent. That text is not redacted. If your logs might
contain secrets or customer data, leave `--llm` off or point
`FLAKY_FINDER_BASE_URL` at a model you run yourself, such as Ollama (see
`.env.example`). This README makes no claim about any provider's retention or
training terms; read the provider's own terms before enabling it.

**A verdict that claims a cause must quote real evidence.** If the model says
`ENVIRONMENT_SIGNAL_DETECTED` or `SUSPECTED_REGRESSION`, it has to include a verbatim
quote of the text that led it there. The tool checks that quote against the evidence
actually sent (after the 4,000 character cut, never the full original text) and
rejects the whole response — `llm-response-rejected` — if the quote cannot be found.
A fluent-sounding explanation with no checkable quote behind it is not accepted as a
verdict.

**`history ingest` stores a summary, not the report.** In
`.flaky-finder/history.db` it keeps:

- for each report: a SHA-256 hash of its content, the run ID, commit SHA,
  environment ID, framework, the report's file path, and the time;
- for each test case: the test name, classname, outcome, and the same run
  details;
- for failed tests only: the verdict, rule ID, rule set version, the
  **matched evidence line**, and the explanation (which quotes that line).

The full report and the full failure text are **not** stored. The evidence
line is still raw log text, though, so it can contain anything that line
contained.

**Retention and deletion.** Nothing expires automatically. History is kept
until you delete it. To delete everything, delete the database file
(`.flaky-finder/history.db`, or whatever path you passed to `--db`). The file
is ignored by git by default, so it will not be committed by accident.
Deleting individual runs or tests is not supported yet.

**If you use the cache example workflow**, the database is uploaded to the
GitHub Actions cache for your repository. It is removed after 7 days without
use ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)).
Treat it like any other CI artifact that might contain log text.

## Limitations

Here they are, stated plainly, because the whole point of this project is to
avoid overclaiming. This section describes what the tool does **not**
establish.

- **A matched signature does not prove a test is flaky.** A timeout caused by
  a slow CI runner and a timeout caused by a real regression (say, an
  element that never renders) produce *exactly the same error text*. The
  rule engine reports the signature either way and says so clearly. It does
  not and cannot tell which one happened.
- **Every log verdict still comes from a single log.** Historical tracking
  (described above) adds a separate assessment based on many runs, but only
  if you ingest JUnit XML reports over time. Without that, there is no run
  history, and FlakyRadar's flip detection remains the more complete version
  of this idea.
- **Support for multiple frameworks is a best effort.** The parser pulls out
  a test name and the failure text. It cannot yet tell apart a first failure
  from a retry that later passed, a test skipped after a setup failure, or a
  failure caused by a different test. Think of each framework's parser as
  "handles the common case", not a complete model of that tool's output.
- **The tests check that the rules behave as written, not that they are
  right.** A passing test suite means the regular expressions match what
  they were built to match. That includes the tricky case where a matching
  signature hides a real regression, the documented order for overlapping
  matches (and that a lower priority observation in the same log is shown
  rather than dropped), basic robustness (empty input, cut off input, same
  result every time), and the checks on the LLM step (`tests/llm.test.ts`
  makes sure a model cannot push `SUSPECTED_REGRESSION` above low
  confidence, an unknown verdict cannot slip through, and broken output
  causes an error instead of a made up result). It is not a measure of
  accuracy against real failures that people have labeled. No such
  benchmark exists yet.
- **A regular expression can match in a misleading place.** Every rule
  matches on literal text. If a log contains one of these strings outside
  its usual meaning (in a comment, a quoted example, or unrelated noise),
  the rule still fires. That risk comes with matching text patterns, and
  this version does not try to explain it away. It is also exactly why
  every match must quote its evidence line, so a person can spot the
  problem right away.
- **Not every open weight model works as the LLM fallback.** This was found
  while building the project: a reasoning ("thinking") model (Qwen3)
  combined with forced JSON output (`response_format: json_object`) through
  Ollama never answered within 2 minutes, even with `max_tokens` set. It is
  a real conflict between forcing structured output and the model's
  internal `<think>` phase, and it cannot be fixed from the client side. A
  plain instruct model (Llama 3.2 or 3.1) has none of these problems and
  answers in seconds. If you run everything locally, choose a model without
  a reasoning phase for this endpoint.

## Supported CI tools

pytest, Jest and Playwright. Adding a framework takes one function in
`src/parser.ts`. Pull requests for Vitest, Go test, JUnit/Maven and RSpec are
welcome, ideally with a few realistic sample logs.

## Roadmap

Done:

- [x] Run history tracking (`history ingest`, `show` and `report`). See
      [Historical tracking](#historical-tracking) for what it does and does
      not establish.
- [x] A documented way to keep `.flaky-finder/history.db` between GitHub
      hosted runners. See
      [Keeping history across CI runs](#keeping-history-across-ci-runs).
- [x] Machine readable `--json` output (what an action that comments on pull
      requests needs).
- [x] Custom rules from a JSON file (`FLAKY_FINDER_RULES_FILE`).
- [x] Failure signature groups: `analyze` groups its own results by the rule
      that decided them. See
      [Failure signature groups](#failure-signature-groups) for what it does
      and does not establish.

Planned:

- [ ] An advisory GitHub Action that comments the verdict on a failing pull
      request check. By default it will **not** retry anything or block a
      merge. A wrong or unclear verdict should never silently change what CI
      does. A team can choose a stricter policy later, on purpose.
- [ ] More frameworks: Vitest, Go test, RSpec.
- [ ] A small benchmark of real failures labeled as flaky, real bug or
      unclear, to honestly measure how often the tool raises a false signal
      or wrongly dismisses a failure, instead of just saying "the tests
      pass".
- [ ] Custom rules in `history ingest`. This needs a database schema change
      (see [Custom rules](#custom-rules-flaky_finder_rules_file)).
- [ ] Grouping errors with similar (but not identical) text. This is on hold
      until there is a written policy for how text gets smoothed out, plus
      examples showing that it does not merge failures that are actually
      unrelated (for example, two different internal hostnames in the same
      error format).
- [ ] Linking failures across *different* rules using similarity or an LLM
      (for example, guessing that a DNS failure and a timeout are the same
      outage). This is on hold until there is a labeled and independently
      checked dataset of multiple failures to measure it against, for the
      same reason as the benchmark above. Grouping failures that already
      share a rule needed no such dataset. Claiming a link between failures
      that *do not* share one is a much stronger claim, and it does.
- [ ] Linking incidents across runs (the history version of failure
      signature groups, working across `failure_evidence` rows instead of
      within one `analyze` run). Not started.

## Contributing

Contributions are very welcome, especially new rules, new framework parsers
and sample logs. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)
