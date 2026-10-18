# flaky-finder

Classifies CI test failures as `LIKELY_FLAKY`, `LIKELY_REAL_BUG`, or `UNVERIFIED`
— with the exact log line as evidence for every verdict, and no silent guessing
when the evidence isn't there.

## The problem

Every team with a CI pipeline eventually has the same conversation: "is this
failure real, or just flaky — can we merge?" People re-run the job, eyeball the
stack trace, and move on. That triage is repetitive, inconsistent between
people, and leaves no record of *why* a failure was waved off.

## Why not just paste the log into ChatGPT?

You can, and it'll give you a confident-sounding answer. But:

- **It's non-deterministic.** Ask twice, get two different answers, with no way
  to tell which one to trust.
- **It can't show its work.** "Looks flaky to me" isn't evidence anyone can
  review in a PR comment.
- **It will round up.** A general-purpose assistant tends to give you a verdict
  either way rather than say "I don't actually know from one run."

flaky-finder is a small, boring, auditable rule engine first: ~12 well-known
flaky-test signatures (network resets, port collisions, stale DOM elements,
timeouts, DB lock contention, test-order pollution, ...), each one matched
against the raw failure text and cited by its *exact matching line*. A failure
that matches nothing gets `UNVERIFIED` — never upgraded to "probably a bug" or
downgraded to "probably flaky" just because something has to be printed. An
open-weight model (via Groq, Ollama, OpenRouter, or anything OpenAI-chat
compatible) is an **optional** second opinion only for the residual cases the
rules don't recognize — and it's held to the same discipline: it isn't allowed
to call something a real bug from a single run either.

This is the same grounding discipline behind
[`camelid-evals`](https://github.com/beinghumantester/camelid-evals): never let
"sounds right" stand in for cited evidence.

## Usage

```bash
npm install
npm run cli -- fixtures/pytest-sample.log
```

```
Parsed 2 failure(s) from fixtures/pytest-sample.log
LLM fallback: disabled (rules-only mode)

🟡 LIKELY_FLAKY  (high confidence, via rule)
   test: test_fetch_user_retries
   evidence: E       requests.exceptions.ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))
   why: The connection was reset mid-request (...). This is almost always an environment/network blip, not a code defect.

⚪ UNVERIFIED  (none confidence, via none)
   test: test_discount_calculation
   why: No known flaky signature matched. A plain assertion mismatch from a single run can't honestly be called a real bug OR flaky — that needs a rerun-history check or code review.

Summary: { LIKELY_FLAKY: 1, UNVERIFIED: 1 }
```

Also bundled: `fixtures/jest-sample.log` and `fixtures/playwright-sample.log`.

### Optional: enable the LLM fallback

```bash
# e.g. a free Groq API key (serves Llama/Gemma/Qwen)
FLAKY_FINDER_API_KEY=gsk_your_key_here npm run cli -- fixtures/pytest-sample.log
```

Without a key, flaky-finder stays in rules-only mode and reports `UNVERIFIED`
for anything it can't place — the same `BLOCKED`-not-`FAIL` honesty as the
project above, rather than a dependency it silently falls back from.

### Run the test suite

```bash
npm test
```

## Supported CI tools today

pytest, Jest, Playwright. Adding a framework is one function in `src/parser.ts`
(detect its distinctive failure-block marker, extract the test name) — PRs for
Vitest, Go test, JUnit/Maven, and RSpec welcome.

## Roadmap (why this isn't a one-weekend throwaway)

- [ ] Ship as a GitHub Action that comments the verdict directly on a failed
      PR check, instead of a local CLI
- [ ] More frameworks: Vitest, Go test, JUnit XML, RSpec
- [ ] Track verdicts over time per test (a test rules flags 5 times in 2 weeks
      is a much stronger flaky signal than once)
- [ ] A `--strict` mode for CI gating: fail the build only on `LIKELY_REAL_BUG`,
      auto-retry on `LIKELY_FLAKY`, surface `UNVERIFIED` for a human

## License

MIT
