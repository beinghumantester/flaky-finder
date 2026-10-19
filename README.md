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

```bash
npm install
npm run cli -- fixtures/pytest-sample.log
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

Summary: { ENVIRONMENT_SIGNAL_DETECTED: 1, UNVERIFIED: 1 }
```

Also bundled: `fixtures/jest-sample.log` and `fixtures/playwright-sample.log`.

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
npm test
```

## Limitations — what this tool does NOT establish

Stated plainly, because the whole point of this project is not overclaiming:

- **A matched signature is not proof of flakiness.** A timeout caused by a
  slow CI runner and a timeout caused by a genuine regression that never
  renders the awaited element produce the *exact same error text*. The rule
  engine reports the signature either way and says so explicitly — it does
  not and cannot resolve which one happened.
- **No run history.** Every verdict comes from a single log. The strongest
  real evidence for flakiness — the same test passing and failing on the
  same commit — is exactly what this tool doesn't have. (That's what
  FlakyRadar's flip-detection is for.)
- **Multi-framework support is best-effort.** The parser extracts a test
  name and failure body; it does not yet distinguish a first failure from a
  retry-that-passed, a skip-after-setup-failure, or a failure caused by a
  different test. Treat each framework's parser as "handles the common
  case," not an exhaustive model of that tool's output.
- **The test suite checks the rules behave as written, not that they're
  right.** 25/25 tests passing means the regexes match what they were built
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

## Supported CI tools today

pytest, Jest, Playwright. Adding a framework is one function in
`src/parser.ts` — PRs for Vitest, Go test, JUnit/Maven, and RSpec welcome,
along with representative sample logs.

## Roadmap

- [ ] Advisory-only GitHub Action: comment the verdict on a failing PR check.
      **Not** auto-retry or auto-merge-block by default — a wrong or
      unresolved verdict should never silently change what CI does; a team
      can opt into stricter policy later, deliberately.
- [ ] More frameworks: Vitest, Go test, RSpec
- [ ] A small labeled benchmark of real flaky/real-bug/ambiguous failures, to
      measure false-signal and false-dismissal rates honestly instead of
      just "tests pass"

### Designed, not yet built: run-history tracking

The single-log verdicts above (`ENVIRONMENT_SIGNAL_DETECTED`, `UNVERIFIED`,
`SUSPECTED_REGRESSION`) can never establish actual intermittency — that
needs evidence across multiple runs, which this version doesn't have. The
plan for adding it, kept conservative on purpose:

- **A separate axis, not a replacement.** A test keeps its log-level verdict
  AND gets an independent historical assessment —
  `INTERMITTENCY_OBSERVED` (same test passed and failed on the same commit),
  `FAILURE_REPEATED` (fails every time, root cause still unknown),
  `PASS_ONLY`, or `INSUFFICIENT_HISTORY`. The verdict describes the log; the
  assessment describes the run history. Never conflate them, and never use
  the failure verdict as a stand-in for test outcome — `UNVERIFIED` isn't
  "passed," and a signal isn't "flaky."
- **Local SQLite**, e.g. `.flaky-finder/history.db` — no server, no account,
  consistent with "local-first." Two tables: test runs (run id, test id,
  framework, outcome, timestamp, commit SHA) and failure evidence (run id,
  matched signature, rule id + rule-set version, evidence line) — kept
  separate so a later change to the ruleset doesn't get confused with a
  change in actually-observed behavior.
- **Needs passing results too, which failure logs alone can't give.** You
  can't detect a fail→pass pattern from a log that only ever shows
  failures. First ingestion format: JUnit XML (pytest/Jest/Playwright can
  all emit it) — it says *which* tests ran and whether they passed, while
  the existing log parsers stay responsible for *why* a failure happened.
- **`INTERMITTENCY_OBSERVED` requires the same commit.** A test failing on
  one commit and passing on the next could be a real fix, not flakiness —
  and even same-commit pass/fail is evidence of intermittent *outcomes*,
  never proof of root cause.
- **CI runners are ephemeral.** A local SQLite file won't survive between
  GitHub-hosted jobs on its own — ship local history first, then a
  documented artifact-based persistence step; a hosted DB only if
  concurrent/team-wide history ever justifies it.
- **Four milestones**, each independently testable before the next starts:
  (1) storage — schema, migrations, duplicate-ingestion handling;
  (2) ingestion — JUnit XML parsing, safe handling of malformed reports;
  (3) analysis — the pass/fail pattern logic and the four assessments above,
  kept structurally separate from the existing verdicts;
  (4) CLI — `history ingest` / `history show` / `history report`, plus docs
  for what each assessment does and doesn't mean.
- **Explicitly not in scope even then:** automatic retries or merge gating
  based on historical assessment — that's a policy decision for whoever
  integrates this, not a default this tool should ship with.

## License

MIT
