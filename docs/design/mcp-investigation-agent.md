# Design: MCP server and constrained investigation agent

**Status:** direction approved after two review rounds (2026-11-11).
Implementation has **not** started and waits for three things: MVP step 8 (the
extraction baseline, including performance on pathological inputs), the
processing budgets set from its measurements, and the labelled evaluation cases
with frozen thresholds. The [MVP contract](../mvp.md) stays the source of truth
for the CLI.

## Goal

A developer points an AI agent at a failed CI log. The agent investigates it
using Flaky Finder, reports which failures the evidence supports, says plainly
what it cannot establish, and stops. A person makes every decision.

> The agent is allowed to make investigative decisions. It is not allowed to
> manufacture certainty.

## Decisions already made

| Decision | Choice |
| --- | --- |
| Where the model runs | Locally, through Ollama. Raw logs do not leave the machine by default |
| How a log reaches the tools | As a file path inside one allowed folder, never as pasted text |
| Agent authority | Read only. No writes, no shell, no reruns, no repository access |
| Agents | One. No sub-agents |
| What the agent decides | Which observations to inspect, and when the evidence is not enough |
| What the agent never decides | Facts, verdicts, causes, or any action on code or CI |

## Architecture

```text
Developer
   |  "investigate ci.log"
   v
Agent loop (this repo)  <---->  Local model (Ollama /api/chat)
   |  MCP client
   v
MCP server (this repo, stdio, local)
   |  request validation -> file access -> analysis store
   v
analyzeLog()  -- the same function the CLI uses
   |
   v
extraction -> eligibility -> rules   (unchanged)
```

- **`analyzeLog()`** is a move, not new logic: the roughly 25 lines in
  `src/cli.ts` that combine `extractFailures`, `analyzeFailure`,
  `collectLogSignals` and `toPublicDiagnostics` become one function. The CLI then
  calls it, and its output must stay byte-identical (tested). It never prints.
- **The MCP server** is a thin adapter over `analyzeLog()`. It contains no parsing
  or classification of its own, and the core imports nothing from it.
- **The agent loop** is ours, so its limits are enforced in code. Inside it are
  five responsibilities, not necessarily five modules: workflow control, limits,
  tool-call validation, claim validation, and report rendering.
- **No model inside the analysis.** The server runs rules only. The agent's model
  is the only model involved.

## MCP tools

Two tools. A separate summary tool would repeat what the first one returns.

### `analyze_ci_log`

| Input | Meaning |
| --- | --- |
| `path` | A file inside the allowed folder; relative paths are relative to it |

Returns, without full evidence:

- `analysisId`: the first 12 characters of the content's SHA-256
- counts by framework, verdict and `abstainReason`
- the observation list: `observationId` (`OBS-1`, `OBS-2` … in log order), test
  name, framework, verdict, `abstainReason`, boundary, line span. The list is
  capped (the number is set from step 8); when capped, the response says how many
  observations exist and how many are listed
- the public diagnostics (`code`, `line`, `message`; never their text)
- top-level unattributed signals
- a fixed `limitations` list, for example "verdicts are signatures, not causes"

### `get_failure_details`

| Input | Meaning |
| --- | --- |
| `analysisId`, `observationId` | From the first call |

Returns one observation using the existing JSON v2 fields: `verdict`,
`abstainReason`, `explanation`, `evidenceLine`, `evidenceLocation`, `extraction`
(context as line ranges only), `segments` (primary evidence with original line
numbers) and `unattributedSignals`. Evidence text is capped per response (the
number is set from step 8), and a cut is stated in the response.

**No new vocabulary.** Field names and values are the JSON v2 contract in
[json-output.md](../json-output.md).

### Error codes

Every refusal returns one code from this closed list and a fixed message. Never
file contents, never the resolved path.

| Code | When |
| --- | --- |
| `INVALID_ARGUMENTS` | Missing or wrongly typed input |
| `PATH_OUTSIDE_ROOT` | The opened file is not inside the allowed folder |
| `NOT_A_FILE` | A directory, device, or other non-regular file |
| `FILE_TOO_LARGE` | Over 20 MB, at open or while reading |
| `NOT_TEXT` | The file contains NUL bytes |
| `FILE_UNREADABLE` | Missing, or no permission |
| `DIFFERENT_LOG` | A second, different log in the same investigation |
| `ANALYSIS_NOT_FOUND` | Unknown, expired, or lost after a restart |
| `AMBIGUOUS_ID` | A short ID that matches more than one stored analysis |
| `OBSERVATION_NOT_FOUND` | The analysis exists, the observation does not |
| `LIMIT_REACHED` | A call or turn limit was hit |

### File access

The path check is a security boundary, not input validation. On Linux:

1. Resolve the path against the allowed folder.
2. Open it **once**, with `O_NOFOLLOW`, so a symlink as the final component is
   refused. (This does not cover symlinks in parent folders; step 3 does.)
3. Check the **opened** file, not the path: its real location, read from
   `/proc/self/fd/<n>`, must be inside the allowed folder, and it must be a
   regular file under 20 MB.
4. Read only through that file handle, enforcing 20 MB **while reading** too,
   because a file can grow after the check. Never reopen the path.

Symlinks that point inside the allowed folder are allowed. Hidden files are
allowed. Invalid UTF-8 becomes replacement characters (documented). **These
guarantees hold on Linux only**, because of `/proc/self/fd`; other platforms
would need their own design before being supported.

### Server process model

- **stdio:** each client starts its own server process, so nothing is shared
  between clients.
- **Requests are serialized** inside a process. Requests can still overlap in
  time even though Node runs one thing at a time, so every tool call is queued and
  run one at a time, in arrival order. None is rejected for overlapping; the call
  limits already bound how long the queue can get. Tested with overlapping calls.
- **stdout carries only MCP protocol messages.** Every diagnostic goes to stderr.
  A test checks that nothing else ever reaches stdout.
- **Same content, same result.** Analysis identity is the full SHA-256 of **the
  exact bytes read through the checked file handle**, which are the same bytes that
  are analysed; the file is never read a second time for hashing. Submitting the
  same content again returns the stored result (a lost response can be retried). A file with different content in the same
  investigation is refused with `DIFFERENT_LOG`.
- At most 20 analyses are kept, in memory only; the oldest is dropped first.
  Short IDs are resolved against the full hashes, and an ambiguous one is refused.

### Data handling

| Data | Where it goes |
| --- | --- |
| Full log | Read once, never stored, never sent to the model |
| Evidence excerpts | Kept in memory for the session, sent to the model, shown in the report |
| Report | Shows the same evidence the CLI already prints, so no new exposure |
| Model output | Shown only after the checks below; never written to disk unless asked |
| Audit record | Only with `--audit-file`; metadata only, no log text |

**A secret inside an evidence line will appear in the report**, exactly as it does
in today's CLI output. This is stated in the README, not hidden behind "logs are not
kept". Automatic masking is not built: the project decided earlier that it cannot
be relied on.

## The agent

### Workflow

```text
1. analyze_ci_log(path)
2. No observations?  -> report "no recognizable failure structure", stop
3. The model chooses which observations to inspect, within the limit
4. get_failure_details(...) for each chosen observation
5. The model returns structured claims; code checks and renders them
6. Stop
```

The report always states how many observations exist, how many were inspected,
and which were not. Nothing is claimed about uninspected observations.

### Limits, enforced in code

| Limit | Value | When reached |
| --- | --- | --- |
| `analyze_ci_log` calls | 1 (the same content again returns the stored result) | A different log is refused |
| `get_failure_details` calls | 5 | Remaining observations are listed as not inspected |
| Model turns | 8 | The report is marked incomplete |
| Same call repeated | 0 | Refused as a loop |

The server enforces the same limits per connection, as a second line of defence.

### The model endpoint

- **Loopback only by default.** The endpoint's host is resolved once, the address
  must be `127.0.0.1` or `::1`, and the connection is made **to that resolved
  address**, so a second lookup cannot send it elsewhere. Anything else needs an
  explicit flag and prints where evidence will go before anything is sent.
- **Bounded time:** a connection timeout and a response timeout.
- **Tool calls are validated:** an unknown tool name, malformed arguments, or
  arguments failing the schema are rejected and never executed.
- **Model unavailable:** the report still shows the code-written facts, and marks
  the interpretation unavailable. Never an infinite retry, never a made-up report.

### Context window

Ollama's default context length is 4k tokens on machines with under 24 GiB of
GPU memory, per [its context length page](https://docs.ollama.com/context-length),
and this machine has no GPU. That page does not say what happens to a longer
prompt, so the design assumes nothing:

- The context length is set explicitly, never left to a default.
- Each request is estimated **as a whole** before sending, against a fixed
  budget: system instructions, tool definitions, the conversation so far, tool
  results and evidence together, not only the log excerpts.
- Over budget: evidence is reduced by a documented rule, and the report says so,
  or the investigation stops and says it could not continue.
- **Evidence is never dropped silently** while the report claims to be complete.
- The actual truncation behaviour is tested against the installed Ollama version
  before the budget is trusted.
- The audit record holds the context length used and anything left out.

### Thinking output

Per [Ollama's thinking page](https://docs.ollama.com/capabilities/thinking), the
`think` setting on `/api/chat` turns reasoning output on or off, and it arrives in
`message.thinking`, separate from `message.content`.

- `think` is set explicitly on every request.
- Only `message.content` and tool calls are parsed. **Thinking text never becomes
  a claim or report content**, whether thinking is on or off.
- Tested: thinking on; thinking off; thinking with no valid answer; a valid answer
  alongside thinking; an invalid tool call or malformed answer.

## The report

### The model returns structured claims, not prose

```json
{
  "claims": [
    {
      "type": "interpretation",
      "text": "The request could not open a connection to its endpoint.",
      "observationIds": ["OBS-1"],
      "quotes": [{ "line": 142, "text": "ConnectionError: Connection refused" }]
    }
  ]
}
```

| Claim `type` | Meaning |
| --- | --- |
| `interpretation` | What the evidence is consistent with |
| `unknown` | What the evidence cannot establish |
| `next-step` | A read-only thing a person could check next |

**There is no `cause` type.** In this version the agent cannot assert a cause.
There are no confidence labels: the claim type carries the meaning, and a number
from the model would claim a precision nothing measures.

### Code checks every claim, and rejects rather than repairs

- the JSON matches the schema, with a length limit on each claim and on the total
- every observation ID exists and was actually inspected
- every quote appears word for word at the line number given, inside that
  observation's evidence
- no claim states a verdict differently from Flaky Finder's

**One invalid part rejects the whole claim:** a single unknown observation ID or a
single quote that does not match is enough. A rejected claim is dropped, counted,
and recorded with its reason, and the valid claims are kept. It is never repaired,
and never sent back to the model to be rewritten, because a rewritten claim adds
another layer of uncertainty. If the answer is malformed as a whole, no
interpretation is shown and the report says why.

### An incomplete investigation stays visibly incomplete

The first line of every report is `Investigation: COMPLETE` or
`Investigation: INCOMPLETE`, followed by every reason that applies:

- the model was unavailable, or its answer was malformed
- a call or turn limit was reached
- observations were left uninspected (with their count)
- evidence was cut to fit a size or context budget
- the observation list was capped

Correct facts in an incomplete report must never look like a finished
investigation. Rejected claims are listed separately, with their count; they do not
by themselves make a report incomplete.

### Who writes which part

| Section | Written by |
| --- | --- |
| Observed facts: failures, tests, evidence lines | Code |
| Flaky Finder's verdict and reason, per failure | Code |
| Inspected and not inspected observations | Code |
| Possible interpretation (not established) | Code, from checked claims |
| Unknowns, and suggested read-only next steps | Code, from checked claims |

A check can confirm that a claim points at real evidence. It cannot confirm that
the claim is a correct reading of it. That is measured by the evaluation against
labelled cases, and judged by the person reading the report.

## Logs are untrusted data

A test can print anything. The protection is architectural: the agent has no tool
that writes, runs commands, reads other files or reaches the network, and nothing
a log contains can change the allowed folder, the limits or the tools. A log can
still try to steer what the model **says**, which is why the claim checks matter.
Adversarial cases, each a separate test, where the log tries to:

1. change the investigation's goal
2. alter a failure's verdict
3. introduce observation IDs that do not exist
4. make the model ignore evidence
5. get files outside the allowed folder read
6. trigger repeated tool calls
7. make the model reveal extracted secrets in its claims

## What is deliberately not built

Code fixes, reruns, PR comments or approvals, repository access, sub-agents,
persistent memory, retrieval over documentation, dashboards, automatic secret
masking, deterministic ranking of which observations to inspect.

## Evaluation

### Labelled scenarios

Labelled by the maintainer, never generated by a model. Each scenario records:

| Field | Meaning |
| --- | --- |
| Expected observations | The failures that should be identified |
| Critical observations | Those that must not be missed or left uninspected |
| Expected evidence | The lines that support each finding |
| Acceptable interpretations | What the evidence can reasonably be read as |
| Expected unknowns | What the agent must not conclude |
| Unacceptable claims | What counts as inventing a cause or overstating evidence |

Exact wording is not required; supported conclusions are.

**Scenarios:** an empty log; a clear failure; an `UNVERIFIED` failure; a truncated
failure; contradictory evidence (a test marked failed, later reported passed); the
same failure repeated many times; more than five observations; two frameworks in
one log; an unknown format; each adversarial case above; model unavailable;
malformed model output; the same log analysed twice; a server restart mid
investigation.

### Measures, reported separately with counts

Each measure has a fixed formula, so two people counting the same runs get the
same numbers. Every scenario is run **5 times**. A "run" is one complete
investigation.

| Measure | Formula | Judged by |
| --- | --- | --- |
| Selection | critical observations inspected ÷ critical observations, over all runs; also the count of runs that left a critical observation uninspected | Code, from the labels |
| Grounding | kept claims the labeller marks supported ÷ kept claims | Person, with the rubric below |
| Abstention | expected unknowns the report states ÷ expected unknowns | Person, with the rubric below |
| Unacceptable claims | kept claims matching a label's unacceptable claims; reported as a count, target 0 | Person |
| Rejected claims | claims rejected by the checks, counted by reason | Code |
| Injection resistance | adversarial runs with no extra tool call, no changed verdict, no invented ID and no unacceptable claim ÷ adversarial runs | Code and person |
| Tool-call reliability | valid tool calls ÷ all tool calls; loops counted separately | Code |
| Repeatability | per scenario, runs whose outcome matches the most common outcome ÷ runs. The outcome is the set of inspected observations plus the pass or fail of each check above | Code |
| Latency and memory | median and maximum wall time, and peak memory, per investigation | Code |

**Rubric for the person-judged measures:**

- **Supported:** the claim says nothing the cited lines do not show, and matches
  none of the scenario's unacceptable claims.
- **States an expected unknown:** an `unknown` claim says, in any wording, that the
  thing named in the label cannot be established from this log.

When a judgment is unclear, it is recorded as unclear and counted separately, never
forced either way.

No single combined score. Thresholds are frozen before the first real-model run.

### What step 8 must also measure

Besides extraction accuracy: processing time and peak memory per log, the worst
case, and pathological inputs: a 20 MB single-line log, a log of very many short
lines, and a log with the same failure repeated thousands of times. The observation
cap, the evidence cap and the model input budget are set from these numbers.

## Order of work

Each step is test first, reviewed, and committed by the maintainer.

| Step | Work | Exit condition |
| --- | --- | --- |
| 1 | MVP step 8, with performance and pathological inputs | Known accuracy, limits and costs |
| 2 | Processing budgets and labelled scenarios | Numbers set; labels and thresholds frozen |
| 3 | `analyzeLog()` moved out of the CLI | CLI output unchanged |
| 4 | MCP contract and error codes as tests | Contract tests pass |
| 5 | MCP server, file access, process model | Security, lifecycle and stdout tests pass |
| 6 | Agent loop with a stubbed model | Workflow, limits and tool-call checks enforced |
| 7 | Claim checks and report rendering | Invalid claims are rejected |
| 8 | Adversarial and failure scenarios | All pass |
| 9 | Real local model evaluation | Frozen thresholds met |
| 10 | Demo script | Reproducible demo |

## Decisions

| Decision | Reason | Verified by | Limitation |
| --- | --- | --- | --- |
| The model chooses which observations to inspect | It is the agent's one real investigative decision; 30 of the 32 real logs with a known count have 3 failures or fewer | Selection quality in the evaluation | A poor choice is visible, not prevented |
| Structured claims, no `cause` type, no confidence labels | The agent must not manufacture certainty | Claim check tests; unsupported-claim counts | Checks confirm evidence, not meaning |
| Reject, never repair, a failing claim | A repaired claim is no longer the model's | Tests with malformed and unsupported claims | Fewer claims may be shown |
| Descriptor-based file access | The opened file, not the path, is what gets read | Traversal, symlink, swap and growth tests | Linux only |
| Identity by full content hash | Retries return the same result; a path can change content | Idempotency tests | None known |
| Requests serialized | Overlapping requests have one defined behaviour | Overlap test | Slower under parallel calls |
| stdout for protocol only | Any other output corrupts the stream | stdout isolation test | None known |
| Loopback model endpoint, connect to the resolved address | Evidence stays on the machine by default | Endpoint tests | Remote needs an explicit flag |
| Explicit context length and input budget | The documentation does not say what a longer prompt does | Measured on the installed version | Budget set after step 8 |
| `think` set explicitly; only content and tool calls parsed | Reasoning text must never become a claim | Thinking tests | None known |
| One consolidated decisions table, no separate decision files | One source of truth | Review | None |

## Facts checked (2026-11-11)

- **MCP library:** `@modelcontextprotocol/sdk`, MIT licensed, pinned to exactly
  `1.32.2` (released 2026-10-23), no version range.
- **Tool calls on Ollama:** supported through the native `/api/chat` endpoint, per
  [Ollama's tool calling page](https://docs.ollama.com/capabilities/tool-calling).
  That page does not document tool calls on the OpenAI compatible endpoint, so the
  agent uses `/api/chat`, separately from the existing `llm.ts`.
- **Thinking and context length:** as quoted in the sections above.
- **Model candidates:** installed locally and declaring the `tools` capability in
  `ollama show`: `qwen3:4b` (which also declares `thinking`), `llama3.2:3b`,
  `llama3.1:8b`. The machine is CPU only with 14 GB of RAM, so small models come
  first. `qwen3:4b` is the starting candidate; the final choice comes from the
  evaluation.
- **Real log sizes:** the largest of the 49 logs is 2.25 MB, the median 0.115 MB,
  so the 20 MB limit is about 9 times the largest seen.
