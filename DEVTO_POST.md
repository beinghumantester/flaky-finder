*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 2: Side Hustle](https://dev.to/challenges/hacktoberfest-week2-2026-10-12)*

## What I Built

**flaky-finder** is a small CLI that reads a CI test-failure log (pytest,
Jest, or Playwright) and classifies each failure as one of three things —
`ENVIRONMENT_SIGNAL_DETECTED`, `SUSPECTED_REGRESSION`, or `UNVERIFIED` —
citing the exact log line behind every verdict, and saying `UNVERIFIED`
rather than guessing when nothing supports a stronger claim.

The problem it's for: every team running CI eventually hits the same
question — is this failure a genuine regression, a flaky test, or an
environmental problem? The usual move is to eyeball the stack trace and
rerun the job. That's repetitive, inconsistent between people, and leaves
no record of *why* a failure got waved off. It's exactly the kind of
recurring, billable-hours triage work a freelance test/CI engineer (which
is the actual work behind my GitHub handle, `beinghumantester`) gets asked
to clean up for clients — and the part of that work that's most draining is
also the most mechanical: recognizing the same handful of non-product
failure signatures over and over, by eye, with no consistent record.

flaky-finder doesn't replace that judgment. It automates the mechanical
first pass — recognize known signatures, cite the evidence, and explicitly
flag what's genuinely unresolved — so a consultant or an internal engineer
spends their billable time on the cases that actually need a human, not on
re-deriving "yep, that's a connection reset" for the hundredth time.

It's free and open source (MIT). The "who pays" isn't a license fee — it's
the time currently spent on triage that this tool is meant to reduce,
whether that's an internal engineer's hours or a consultant's billed time.

## Demo

flaky-finder is a CLI, not a hosted app, so there's no deployed link.
Here's real output from an actual run against a bundled sample log —
nothing staged:

```
🟡 ENVIRONMENT_SIGNAL_DETECTED  (signature-match: exact, via rule)
   test: test_fetch_user_retries
   evidence: ConnectionResetError(104, 'Connection reset by peer')
   why: The connection was reset mid-request (...). This is a network
   signature — it can occur for several different reasons, and the log
   alone does not establish which one, or whether the test is actually
   intermittent. Treat this as a lead to check, not a confirmed diagnosis.

⚪ UNVERIFIED
   test: test_discount_calculation
   why: No known failure signature matched. This log alone does not
   establish whether the failure is caused by a product defect, the test
   itself, or the environment.
```

The repo's GitHub Actions badge (type-check + the full test suite, running
on every push) is the closest thing to a live demo — it's a CLI tool, so
"does it work" is best shown by "does CI stay green."

## Code

**https://github.com/beinghumantester/flaky-finder**

## How I Built It

The core is a deterministic rule engine — plain TypeScript, no model call —
that matches a failure's text against ~11 known non-product failure
signatures (connection resets, stale DOM elements, timeouts, DB lock
contention, ...) and reports what it found, explicitly hedged: a matched
signature is "present in the text," never proof the test is flaky.

The **optional** second layer only runs on the cases the rules can't place,
and I tested it against two different open-weight setups:

- **Groq**, serving `openai/gpt-oss-20b` (OpenAI's open-weight GPT-OSS
  model) over an OpenAI-compatible API.
- **Local inference via Ollama**, running `llama3.2:3b` entirely on my
  laptop — no API key, no external inference API, no need to send log data
  to a third-party model provider.

In the case I tested, both returned `UNVERIFIED` rather than guessing a
root cause — encouraging, but one observed result, not evidence of
consistent model behavior across a wider range of inputs. What *is*
code-enforced regardless of what the model claims: its response is
whitelisted against the known verdicts, and `SUSPECTED_REGRESSION` is
capped at low confidence no matter what confidence the model reports.

I also hit a real, instructive failure: Qwen3 (via Ollama) combined with
forced JSON output stalled past any reasonable timeout under my tested
configuration — I suspect an interaction between constrained decoding and
the model's reasoning mode, documented as an observed limitation, not a
confirmed cause.

25 automated tests (type-checked, run in CI on every push) cover the rule
engine's behavior — including an adversarial case where a matching
signature masks a real regression, a documented precedence rule for
overlapping signatures, and the LLM step's own constraint-enforcement logic
(verdict whitelisting, confidence capping, malformed-response handling)
tested directly against controlled inputs, without needing to mock a live
model call.

## Why Does Open Innovation Matter?

Two concrete things an open ecosystem gave me that a single closed API
wouldn't have:

**I didn't get locked into one vendor's availability.** Partway through
building this, the specific Groq-hosted model I'd configured
(`llama-3.1-8b-instant`) had been retired and returned a clean 404. Because
the whole project is built against the open, OpenAI-compatible chat
completions shape rather than one vendor's SDK, swapping to a different
open-weight model (`openai/gpt-oss-20b`) — or dropping Groq entirely in
favor of fully local inference via Ollama — was a config change, not a
rewrite. A single closed provider going away, changing pricing, or rate-
limiting wouldn't have given me that option.

**Local inference makes a real privacy property possible, not just a
talking point.** CI logs can contain internal URLs, stack traces, and
occasionally sensitive paths or data. Running `llama3.2:3b` via Ollama
means that data never has to leave the machine running the CLI at all — not
"we have a policy about it," but an actual architectural option that
exists because open-weight models can be run locally in the first place.

There's a smaller but real third one: the entire rule engine and the LLM
constraint logic together are a few hundred lines, readable start to finish
in one sitting, MIT licensed. Anyone can audit exactly what it does and
doesn't claim — which is the whole point of a project about not overclaiming.

## My Agent Session

This was built in an AI pair-programming session with Claude Code — including
several rounds of the AI critically reviewing its own earlier output and
catching real overclaims (a rule matching a signature isn't proof of
flakiness; a bare "confidence" score next to a hedge was self-contradictory;
a conflicting second observation was getting silently dropped). The fixes
those reviews produced are in the commit history, not just this writeup.

<!-- Session link intentionally left for you to add/remove — see note below. -->

## Prize Categories

None of the specific partner categories (Render, TabPFN, Tinker, Arduino,
DigitalOcean, Gemma, Tiger Data, a `.tech` domain) apply — this project
doesn't use any of those integrations. Submitting to the general challenge
only.
