# Jev evaluation — frozen contract

This directory measures one specific question, decided before any example was
written: **does Jev, used as an alternative to the existing LLM fallback at the
same seam (`src/llm.ts`), produce a measurably better `Verdict` than that
existing fallback — on exactly the failures the existing fallback actually
sees?** Not whether Jev is impressive in isolation, and not whether it's
"smart." See the main README's "Why not just paste the log into an AI
assistant?" section for why that distinction matters to this project.

Everything below is frozen before Stage 1 runs. Changing a rule here *after*
seeing results defeats the purpose of writing it down first.

## The answer set given to Jev

Jev's own interface is: send a state, a question, and an answer set you
define — it was never going to have its own fixed classification vocabulary
for this task. So Stage 1 asks it the **same three-way question** the
existing LLM fallback is already asked (see `SYSTEM_PROMPT` in `src/llm.ts`):

```
ENVIRONMENT_SIGNAL_DETECTED | SUSPECTED_REGRESSION | UNVERIFIED
```

No category-to-verdict mapping step exists in the primary experiment. That
removes a whole unvalidated judgment call, and makes the comparison to the
existing fallback exactly apples-to-apples — same seam, same question, same
possible answers.

`expectedCategory` on a labeled example (when present) is **optional,
diagnostic, free-text metadata** — it helps explain *why* a verdict mismatch
happened. It is never scored, and it is not a controlled taxonomy requiring
its own mapping table.

## Which examples count: computed, not labeled

Whether an example is in the "unmatched subset" (the only subset either
fallback ever runs on in production) is **determined by actually running
`classifyWithRules` against the example's raw log text**, with no custom
rules, and checking `source !== "rule"`. It is never a human judgment call
recorded in the label file — that would let a labeling mistake silently
decide which examples the fallback comparison even covers. Every example's
fixture is a real, parseable log file; this check is re-run every time the
dataset changes, not computed once and trusted.

Examples where `classifyWithRules` already produces `source: "rule"` are
still included in the dataset (they're needed for the "rules-only, complete
dataset" row below) but are **excluded from the Jev-vs-LLM-fallback
comparison** — scoring either fallback on a case rules already resolve would
credit them for work neither of them actually did.

## Scoring rubric (per example that reaches the fallback)

| Outcome | Meaning |
| --- | --- |
| `CORRECT` | Returned verdict matches `expectedVerdict`. |
| `UNDER_CLAIM` | Returned `UNVERIFIED`, but `expectedVerdict` was more specific. Safe — this project already treats `UNVERIFIED` as a legitimate outcome everywhere else — but still tracked, since a classifier that always abstains is useless. |
| `OVER_CLAIM` | Returned a specific verdict that's wrong, **or** returned a specific verdict when `expectedVerdict` was `UNVERIFIED` (insufficient evidence). This is the outcome this project cares most about minimizing — it's the literal thing "never round insufficient evidence up to a confident answer" exists to prevent. |
| `SERVICE_FAILURE` | The API call errored, timed out, or returned something that didn't parse into a valid verdict. Tracked separately from `OVER_CLAIM` — this is the integration being unavailable, not the classifier being wrong. |

## Metrics computed

- Accuracy (`CORRECT` / total scored)
- **Over-claim rate** (`OVER_CLAIM` / total scored) — weighted most heavily of all of these
- Under-claim rate
- Service-failure rate
- Per-verdict precision/recall (three-way)
- Latency (p50 / p95)
- Repeatability (same input, several repeated calls, % identical verdict)

**Always stratified by framework and by `expectedVerdict`, never reported as
one blended number alone.** An aggregate score can look fine while hiding a
real weakness confined to one framework or one verdict category — report the
aggregate *and* the breakdown, every time.

**Every individual case's actual outcome is recorded in the report, not just
summary statistics.** A run that produces only aggregate numbers makes it
impossible to tell "the model got this specific case wrong" from "our label
for this case was questionable" — and a wrong label is exactly as likely an
explanation as a wrong classification until someone actually looks.

## Baseline anchors get their own report, separate from the fallback comparison

The 13 rules-only baseline cases are not spectators — they're a standing
regression check on `classifyWithRules` itself, re-run every time `rules.ts`
or this dataset changes. Report, for the baseline set alone:

- Correct verdicts (the rule's own verdict matches `expectedVerdict` — true
  for every case here today, but not something to assume forever)
- Incorrect verdicts (a rule fired with the wrong verdict)
- Abstentions (a case expected to match a rule, but `classifyWithRules`
  returned `source: "none"` instead — a sign the rule's pattern drifted or
  the fixture's wording did)
- False environmental signals (a rule claimed `ENVIRONMENT_SIGNAL_DETECTED`
  on a case that shouldn't have matched any rule at all)

Never reported as a single "N cases matched a rule" count — that number is
compatible with the rule engine being quietly wrong in ways a raw match
count would never surface.

## Mixed-evidence labeling policy

A log can genuinely contain more than one signal. The policy, stated once
so no two labelers have to improvise it independently:

> When a log contains multiple failure signals, classify the failure
> responsible for the test's *observed* failure, using the strongest
> directly relevant evidence. If the evidence does not establish which
> signal caused the failure, label it `UNVERIFIED`. Do not select an
> environmental verdict merely because an environmental-sounding phrase
> appears *somewhere* in the log.

Concretely:

- A network error in an unrelated **setup step**, with the test's actual
  assertion failing for an unconnected reason, does not make the case
  `ENVIRONMENT_SIGNAL_DETECTED` just because the word is present. Relevance
  to the observed failure is the test, not presence.
- An application assertion failure alongside an unrelated timeout: the
  timeout doesn't get to dominate the classification just by being there.
- The log contains an exact phrase a built-in rule recognizes, alongside a
  separate assertion mismatch — already handled deterministically.
  `classifyWithRules`'s existing co-occurrence logic (`alsoMatched`, the
  "also present in this log, not discarded" caveat — see the main README's
  "How rules are evaluated") surfaces both observations rather than
  silently picking one. Such a case belongs in the **baseline** set, not
  the fallback-comparison set — it never reaches either classifier.
- The log contains two generically-worded signals where relevance to the
  observed failure is **genuinely undetermined from the text** (not merely
  "more than one phrase is present"): `expectedVerdict: UNVERIFIED`.
  Picking the "more important-sounding" one would be exactly the kind of
  inference-over-evidence this project's whole design resists.

Every case built under this policy records *why* relevance was or wasn't
established in its `labelRationale` — that write-up is what makes the
relevance judgment inspectable and contestable, rather than a second hidden
taxonomy bolted onto the label file.

**Scope boundary:** this dataset tests classification of *one* failure.
Whether a single CI run contains several *independent* failures — and
whether to report one primary verdict or several findings for it — is the
failure-*grouping* feature's question (`src/failure-grouping.ts`,
`tests/failure-grouping.test.ts`), already covered there, and deliberately
out of scope here. Every case in this dataset is one failure block, by
construction.

## Stage 2 advancement bar (frozen before any result exists)

Jev advances to Stage 2 (`src/jev.ts`, opt-in integration) only if, on the
held-out set, **evaluated separately for synthetic and real data**:

1. Jev's accuracy on the fallback-reaching subset exceeds the existing LLM
   fallback's accuracy on the identical subset.
2. Jev's over-claim rate is **not higher** than the existing LLM fallback's
   over-claim rate on the identical subset — it may not trade safety for raw
   accuracy.
3. Service-failure rate is recorded and judged for practicality once real
   numbers exist (no threshold fixed yet — there's no basis for one until
   there's a first real run).

**Given the dataset size (15–20 held-out examples, a subset of which reach
the fallback), this is a go/no-go signal for continued investment, not a
statistically significant claim.** A marginal or close result means
"inconclusive — gather more data, especially real logs, before deciding,"
not a verdict either way. This caveat is itself part of the frozen contract:
nothing here licenses treating a 15-example run as proof either way.

## Dev / held-out split

Frozen in `splits/v1.json` once the full case list exists — not before,
since a split needs real case ids to assign. Target: ~30 development
examples (used to validate the dataset format itself and sanity-check the
question wording), ~15–20 held-out examples, touched only for the final
comparison run. The held-out set is never used to tune anything.

## Synthetic vs. real

Scored and reported separately, always — never blended into one number.
Synthetic labels are authoritative by construction: we wrote the scenario,
so the label is simply true. Real labels are necessarily best-effort human
judgment, and "cause unknown" is a legitimate, expected label there — that's
not a weaker dataset, it's an honest one. See the main README's "Data
handling and privacy" section for the additional redaction pass real logs
need before they're committed here.

**Single-author construct-validity caveat.** This is a separate risk from
"synthetic vs. real," not a restatement of it: every synthetic example in
this dataset was written by one author, which means there is likely a
stylistic tell across them — a tendency to phrase environment evidence as
"corroborated by X" or regression evidence as "consistent across every
run," say. A classifier could learn to pattern-match *that authorial habit*
rather than actually reason about the failure, inflating synthetic-set
accuracy in a way that will not transfer to real logs written by other
people in other styles. There is no fix for this other than real logs from
independent sources — synthetic-set performance is a necessary signal
(a classifier that fails here isn't worth pursuing further) but never a
sufficient one, and should never be reported as if it were.

> All synthetic evaluation cases were authored by a single individual. The
> classifiers may exploit stylistic or structural patterns introduced by
> the author rather than learning generalisable failure characteristics.
> Consequently, strong performance on this dataset does not establish
> real-world classification reliability.

Any report produced from this dataset carries that statement, unedited,
next to its headline number — not as a footnote.

## Versioning

The case set is append-only once reviewed: an existing case's id, log text,
or expected label is never silently edited — only appended to, in a new
dataset version, with the change visible in the diff. If a label turns out
to be wrong on review, the fix is a visible, explained change to that one
case, not a silent edit indistinguishable from the original.
