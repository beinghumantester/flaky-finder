# MVP contract

**Status:** proposed. It is frozen when this file is committed, **before** the step 8
run. Any change after that is recorded at the end of this file as an amendment, with
its date and reason, and never silently edited in place.

The point of freezing it is to make it hard to move the goalposts when results are
uncomfortable. If the tool fails these criteria, that is the result: fix the tool and
rerun. Lowering a threshold because of a bad result is not an acceptable amendment.

## The product

Point Flaky Finder at a failed CI log and see in seconds which tests failed, where in
the log, and the exact evidence. It flags a known environment signature only when that
signature is in the failure's own evidence, and otherwise says plainly that it cannot
tell.

Finding failures is the main value. Classifying them is a bonus. The tool is judged
first on whether it finds the right failures without inventing, merging or missing
them, and only second on its verdicts.

## Acceptance criteria

Measured on the datasets in "Evaluation". A rate is **never** reported alone: always
with its numerator and denominator, for example `19/20 (95%)`. With samples this
small, a pass is weak evidence. `9/10` meets an 85% threshold but does not show that
the true rate is above 85%.

**Extraction is the release gate.** The extraction rows below decide whether the MVP
passes. Classification is evaluated and reported separately, and does not block
release unless an amendment says so. Neither result may be used to hide the other.

| Area | Condition |
| --- | --- |
| Extraction precision | ≥ 95% of extracted failures match a labelled failure |
| Extraction recall | ≥ 90% of labelled failures are extracted |
| Evidence attribution | ≥ 95% of matched failures have correct evidence and lines |
| Per framework | No supported framework below 85% recall, decided only when it has ≥ 10 labelled failures |
| Duplicate handling | ≥ 95% correct, decided only when there are ≥ 10 labelled repeat cases |
| DNS regression | The known `ModuleNotFoundError` case gives no environment verdict. This is a fix for one known bug, not a classification accuracy gate |
| Evidence shown | Every extracted failure shows its evidence in the text output, verdict or not |
| Input | A file path, or `-` for stdin |
| Packaging | `npm pack`, installed into a clean folder, runs `flaky-finder --version` and analyzes a log |
| Piping | `flaky-finder ... \| head` exits cleanly, with no stack trace |
| Determinism | Same input bytes, options, environment variables and tool version give byte-identical `--json` output, compared as the whole document: every field, including locations, diagnostics, groups and signals |
| Exit codes | Documented, and a verdict never changes them (see below) |
| GitHub Actions | One working example writes the result to the job summary |
| LLM | Off by default, labelled experimental, and excluded from every accuracy claim |
| Documentation | Supported formats, limitations and exit codes are written down |

The thresholds were proposed by an external review. They are engineering acceptance
criteria for this project, not established industry standards.

**No single overall score decides success.** pytest, Jest and Playwright are reported
separately. A framework or category below its minimum sample size is reported, and
marked "sample too small to decide".

## Exit codes

| Code | When |
| --- | --- |
| `0` | Analysis finished, whatever the verdicts, including all `UNVERIFIED`, and including a log with no recognizable failure structure |
| `1` | Runtime error: unreadable input, bad custom rules file |
| `2` | Usage error: unknown flag, missing argument |

`UNVERIFIED` never means the command failed.

## Evaluation

### Datasets

| Set | Logs | Role | Can it be tuned against? |
| --- | --- | --- | --- |
| Development | The 49 baseline logs | Baseline, and measuring fixes | Yes. Results here are not independent validation |
| Holdout | 20 to 30 new logs | Evidence that the extractor generalizes | No. If anything is fixed because of it, it becomes a development set and a new holdout is collected |

**Holdout selection:** logs are chosen by repository and framework only, never by
running Flaky Finder first. The set deliberately includes enough Jest and Playwright
failures (aim for ≥ 10 each), because the development set has only 6 Jest logs.

**Order:**

1. Run the development set against the current code and record the commit SHA. This is
   the baseline.
2. Fix the DNS false positive, with a regression test from the real excerpt, then rerun
   the development set. This measures the improvement, not generalization.
3. Select, label and freeze the holdout labels, then run the holdout once.

Every run saves its full JSON output, the commit SHA, and the exact command.

### What is labelled

- **Unit:** one failed test occurrence, as the test runner itself reports it. Labels
  are per failure, not per log. The existing `labels-v1` labels are per log and stay
  unchanged.
- **In scope:** failures in the supported frameworks (pytest, Jest, Playwright).
- **Out of scope, counted separately:**
  - logs from other frameworks (Vitest, Go)
  - non-test jobs (lint, rollup, notification)
  - job-level failures with no test, such as a setup step crashing

  These are reported as their own counts, and they affect neither precision nor
  recall.

Each labelled failure records:

| Field | Meaning |
| --- | --- |
| `logId` | Which log |
| `framework` | `pytest`, `jest` or `playwright` |
| `testName` | As the runner prints it |
| `startLine`, `endLine` | The failure's own output in the original log: from its header line to its last line, ignoring trailing blank lines |
| `evidenceLines` | The essential lines: the ones a person would point to as the reason it failed |
| `repeatOf` | Set when this occurrence is a repeated report of an earlier one, for example a summary entry or a reprinted section |
| `labelStatus` | `certain` or `ambiguous` |
| `notes` | Why, when `ambiguous`; anything else worth knowing |

**Line numbers are always from the original log file**, read directly from it. They
are never worked out from an excerpt or a copied fragment.

**Ambiguous labels are kept apart, never forced.** An uncertain ground truth is worse
than none. An `ambiguous` label is left out of precision and recall, and so is an
extracted failure that matches only an ambiguous label. Their count is reported next
to every result, so a large number of them is visible.

**Who labels:** a person. An AI assistant may draft entries, but every entry is
checked and signed off by a person, as with the excerpts. Labels are made **without
looking at Flaky Finder's output for that log**. The runner's own summary (pytest's
`short test summary info`, Jest's failure counts, Playwright's `N failed` list) is the
starting list of failing tests, because it is independent of this tool.

### Matching an extracted failure to a label

An extracted failure and a label are candidates when the framework matches, the test
name matches (after trimming whitespace), and their line ranges overlap.

| Situation | Counted as |
| --- | --- |
| One extracted failure, one label | Matched |
| A label with no extracted failure | Missed |
| An extracted failure with no label | Invented |
| One extracted failure covering two labels | Incorrect merge |
| One label split into several extracted failures | Incorrect split, unless the labels mark them as separate occurrences |
| Anything else that is not one to one | Ambiguous, reported, and never counted as correct |

**The unknown-format observation is not a failure claim.** When nothing is recognized,
the tool reports one `unrecognized-log-format` observation that cannot get a verdict.
It is not counted as invented. Any labelled failures in that log count as missed.

### Correct evidence

Exact boundary equality is too harsh: one extra line can still hold exactly the right
evidence. A generous tolerance is too weak: an extractor could include a lot of
unrelated text and still pass. So correctness is two conditions, both required:

1. **Coverage:** every labelled `evidenceLine` is inside the extracted failure's primary
   evidence. Captured output and lines outside the span do not count.
2. **No unrelated content:** the extracted span contains **at most 2** non-blank lines
   outside the labelled `startLine` to `endLine`, and **none** inside another labelled
   failure's range.

For example, with a labelled failure on lines 100 to 110 and essential evidence on
103 to 108, an extraction of 101 to 110 is correct, but 80 to 150 is not.

Every failed check records which condition failed. The start and end differences
(extracted minus labelled) are reported for every matched failure, correct or not, as
diagnostic data, so boundary drift is visible even when it passes.

### Duplicate handling

Measured on labels with `repeatOf`, and on labels for distinct occurrences that look
alike. A repeated report must not become an extra failure, and a distinct occurrence
must not be merged away. The development set has only a few such cases, so this is
expected to be reported as "sample too small to decide".

### What every report contains

Per framework, with counts:

- matched, missed, invented, incorrect merges and splits, ambiguous
- precision and recall
- evidence attribution, with each failure's reason
- duplicate handling
- out-of-scope counts
- verdicts as a secondary table, with the LLM excluded

## Not in the MVP

- **Not promoted:** failure history and failure grouping. Their code stays unless it
  gets in the way.
- **Out entirely:** Jev, dashboards, PR bots, automatic flaky marking, new rules,
  Vitest.
- **The LLM step** stays behind `--llm`, experimental, and outside every accuracy
  claim.

## Amendments

None yet.
