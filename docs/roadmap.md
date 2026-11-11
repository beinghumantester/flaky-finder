# Roadmap: evidence first

**Status:** approved through phase 6, subject to a privacy review of the excerpts
and a detailed review of the extraction design.

**Current priority:** the [MVP contract](mvp.md) comes first. It makes failure
extraction the main value and measures it before any further classifier or LLM work.
Phases 4 to 6 below wait until its acceptance criteria are met.

## The goal

Demonstrate, with reproducible evidence, whether an LLM makes flaky-finder's
analysis better than it was before. If the answer is no, that is still a valid
result. The goal is not to integrate an LLM.

The tool should answer three questions, in this order:

1. Does it extract the correct evidence?
2. Does it reach defensible conclusions from that evidence?
3. Does AI improve those conclusions compared with the baseline?

Each phase starts only when the one before has met its exit condition.

## Why this order

Real logs exposed problems that synthetic tests did not. On 53 synthetic cases, all
13 rule matches were correct. On 49 real logs, none of the 6 environment signals
identified the real cause.

| Finding on the 49 real logs | Result |
| --- | --- |
| Logs where no labeled evidence reaches the LLM | 19 |
| Real environment logs whose evidence reaches the LLM | 0 of 4 |
| Real environment logs with no test framework output to extract | 3 of 4 |
| Score for always answering `UNVERIFIED` | 39 of 49 (80%) |

## Phases

| Phase | Work | Exit condition |
| --- | --- | --- |
| 1 | Resolve open decisions and freeze existing evidence | Baseline and labels preserved |
| 2 | Failure extraction, eligibility check, parser corrections | Only complete, attributable evidence can influence a verdict |
| 3 | Job level evidence | Job level failures are represented without inventing test failures |
| 4 | Fresh real logs | An independently selected and labeled evaluation set |
| 5 | Evaluation harness | Rules-only and the existing LLM measured against frozen criteria |
| 6 | LLM contract v2 | v2 measured against v1, with the result reported either way |
| 7 | Jev comparison | Runs only if access and evaluation conditions are met |
| 8 | Investigation assistance | Missing evidence suggestions show practical value |

**Stopping point:** the commitment ends at phase 6. Phases 7 and 8 are parked until
their conditions are met. RAG, agents, dashboards, automatic fixes and additional
providers are also parked.

### Phase 2

Follows the implementation order in
[the extraction design](design/failure-evidence-boundaries.md). Exit numbers are
written down before the 49 logs are rerun, so the results cannot shape them.

### Phase 3

Not every CI failure belongs to a test. A spot instance interruption can end a job
with no failed test, so it must not create one.

| Observation type | Example |
| --- | --- |
| Test failure | A pytest assertion |
| Environment failure in a test | A Playwright browser disconnect |
| Job failure | A spot instance interruption |
| Job setup failure | A dependency that fails to install |

This gets its own design and evaluation. Job level failures may not use the same
classification contract as test failures.

**Scope change:** this moves flaky-finder beyond flaky test analysis toward wider CI
failure investigation. This is deliberate, and the README must say so when it ships.

### Phase 4

Logs are chosen without running the tool, and labeled before its output is seen.
The set needs many more environment and regression cases, because the current 49
logs contain only 4 and 6. Those 49 informed the design, so they cannot validate it.

### Phase 5

There are three classifier runs: rules-only, the existing LLM and, later, Jev. The
combined pipeline rows are calculated from those outputs.

The frozen contract in [evaluation/README.md](../evaluation/README.md) does not
change, including its pass criteria. Macro F1 and cost are supplementary columns.
A run on real logs with the new extraction is a new experiment, so its own contract
is written before it runs.

**Entry gate.** The evaluation harness is not built until its contract defines two
separate evaluations:

| Evaluation | Unit | Questions |
| --- | --- | --- |
| Extraction | Each labeled failure in a log | Was it found? Was anything missed, merged or invented? Are the lines, framework and test identity right? |
| Classification | Each individually labeled failure | Right verdict? Relevant and sufficient evidence? Abstained when it should, and only then? |

- **A log level label is never copied onto every failure in that log.** One log
  can hold an environment failure and two regressions, so a log may have no single
  right verdict. Log level labels score log level results only, unless the log has
  exactly one failure.
- **Labels per failure come first.** The 49 `labels-v1` labels are one per log.
  Failure level labels are added as a new, separately reviewed version, never by
  copying a log label down.
- **Matching rule:** an extracted failure and a labeled one are candidates when
  framework, test identity and line overlap all agree. Test names alone are not
  enough, because retries and parametrized tests repeat them.

| Candidates | Treatment |
| --- | --- |
| One extracted failure, one label | Matched; scored for classification |
| One extracted failure, several labels | Ambiguous; counted as a likely merge error |
| Several extracted failures, one label | Ambiguous; counted as a likely split error |
| A label with no candidate | Missed failure |
| An extracted failure with no candidate | Unmatched extraction; possibly invented |

Ambiguous cases are never settled by taking the first candidate. They are
reported as extraction errors and left out of classification scoring, and their
count is shown beside the classification score.

- **Missed failures are reported.** A parser that extracts only the easy failures
  would otherwise show excellent classification scores.
- **Classification is scored only on matched failures,** and the share that matched
  is reported next to it.

### Phase 6

- **Baseline:** the existing prompt stays unchanged. The stricter prompt is a
  separately versioned contract.
- **Input:** a structured failure observation, not a slice of text.
- **Output:** each evidence reference gives a line range and a quote.
- **Confidence:** stays `low` or `medium`. A number would claim a precision nothing
  calculates.
- **Validation:** referenced lines exist, the quote appears in that span, the span
  belongs to the supplied failure, and verdict and confidence limits still hold.
  Anything else fails safely to `UNVERIFIED`.

A valid quote proves the model cited real text. It does not prove the model
interpreted it correctly, which still needs human labels.

## How results are measured

Verdict and evidence are scored separately.

| Metric | Question |
| --- | --- |
| Verdict correctness | Did the tool return the expected verdict? |
| Evidence correctness | Does the cited evidence support that verdict? |
| **Evidence backed verdict rate** | How often are both true? This is the main metric. |
| Evidence eligibility rate | What share of failures have complete, attributable evidence? |
| Abstention quality | Does it abstain on ambiguous cases, and not when evidence is sufficient? |

A correct verdict from unrelated evidence is not a successful diagnosis. For
example, `/ENOTFOUND/i` matches inside `ModuleNotFoundError`. On a missing dependency
log that gives an environment verdict for the wrong reason: the verdict is correct,
the evidence is not, and overall it counts as incorrect. Fixing that rule may lower
verdict accuracy while improving the tool.

A high `UNVERIFIED` rate is not automatically good, and accuracy alone is not
reported as a headline number.

Every rate is reported with its counts, for example `3/4 (75%)`. With a small
dataset a percentage alone looks more convincing than the data justifies.

Both kinds of error are reported: false diagnoses, and missed chances to make a
defensible one. A tool that abstains on everything is safe but not useful.

### What each count means

| Count | Meaning |
| --- | --- |
| Failures | Observations after structurally repeated reports are merged |
| Attempts | Retry spans inside one observation; never extra failures |
| Merged copies | Reprinted blocks removed, each with a diagnostic |
| Possible duplicates | Identical blocks kept because the structure was unclear; each still counts as a failure |
| `occurrenceCount` | Observations in a failure group, after merging |
| `affectedTestCount` | Distinct test names in a failure group |
| Rule matches | Matches in primary evidence that decided or joined a verdict |
| Unattributed signals | Matches that could not decide a verdict |
| Diagnostics | Things extraction declined or merged; never failures |

## Output contract

`analyze` JSON moves to `schemaVersion: 2` in Phase 2, because failure counts and
the meaning of `UNVERIFIED` change, not only because fields are added. The
versioning policy is in the [design](design/failure-evidence-boundaries.md#compatibility).
History output stays at version 1.

## Data and providers

| Data | Provider |
| --- | --- |
| Synthetic examples | Groq or Ollama |
| Reviewed public CI excerpts | Groq or Ollama |
| Full, unreviewed real logs | Local Ollama only |
| Sensitive organizational logs | Local only, subject to that organization's policy |

Only individually reviewed excerpts go in this repository. The full logs stay out
of it. Local inference protects privacy, but it does not imply good quality.

Every report records the model, endpoint, prompt version and date.

**Before any hosted evaluation run:**

- The `--llm` opt-in, the payload limits, and the payload tests from the design
  are in place.
- Only primary evidence of eligible failures from reviewed excerpts is sent.
- The provider's current data terms are read and linked in the report. No claim
  about retention or training is made beyond what those terms say.

## Open conditions

- Jev access is not established, so nothing here depends on it.
- A Groq key has not been confirmed.
