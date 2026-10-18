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

🟡 ENVIRONMENT_SIGNAL_DETECTED  (high confidence, via rule)
   test: test_fetch_user_retries
   evidence: E       requests.exceptions.ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))
   why: The connection was reset mid-request (...) — a network-layer signature. This identifies a known non-product signature in the failure text — it is NOT proof the test is actually intermittent. Only rerun history or code review can establish that; treat this as a lead to check, not a confirmed diagnosis.

⚪ UNVERIFIED  (none confidence, via none)
   test: test_discount_calculation
   why: No known failure signature matched. A plain assertion mismatch from a single run can't honestly be called a confirmed bug OR an environment issue — that needs a rerun-history check or code review.

Summary: { ENVIRONMENT_SIGNAL_DETECTED: 1, UNVERIFIED: 1 }
```

Also bundled: `fixtures/jest-sample.log` and `fixtures/playwright-sample.log`.

### Optional: enable the LLM fallback

```bash
# e.g. a free Groq API key (serves Llama/Gemma/Qwen)
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
  right.** 12/12 tests passing means the regexes match what they were built
  to match, including the adversarial case where a matching signature masks
  a real regression. It is not a validated accuracy benchmark against
  labeled real-world failures — there isn't one yet.

## Supported CI tools today

pytest, Jest, Playwright. Adding a framework is one function in
`src/parser.ts` — PRs for Vitest, Go test, JUnit/Maven, and RSpec welcome,
along with representative sample logs.

## Roadmap

- [ ] Advisory-only GitHub Action: comment the verdict on a failing PR check.
      **Not** auto-retry or auto-merge-block by default — a wrong or
      unresolved verdict should never silently change what CI does; a team
      can opt into stricter policy later, deliberately.
- [ ] More frameworks: Vitest, Go test, JUnit XML, RSpec
- [ ] Run-history tracking, to move from "signature detected once" toward
      actual flip-based flakiness evidence
- [ ] A small labeled benchmark of real flaky/real-bug/ambiguous failures, to
      measure false-signal and false-dismissal rates honestly instead of
      just "tests pass"

## License

MIT
