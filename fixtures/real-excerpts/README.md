# Real log excerpts

Small excerpts from public GitHub Actions logs, used as parser regression fixtures.

**Review status: reviewed in full by the maintainer on 2026-11-10, with no
sensitive content found.** All 13 files were read in full, in their final form
(after the `example.invalid` change below). Two AI-assisted reviews came first:
one by the assistant that prepared the files, one by an external AI reviewer
working from the published commit. Neither found anything beyond public
documentation links and CI account paths such as `/home/runner`, and the external
review recommended the one change made below.

Limits of this review: the files were already public in `76a847a` before any
human review, and they stay in Git history either way. A review is a check, not a
guarantee. If anyone finds sensitive content in a file, report it so that it can
be removed and, if it is a credential, rotated.

## What is where

| Version | Where | Public? |
| --- | --- | --- |
| Original full logs | The maintainer's private baseline snapshot (from `85d34e2`), named `<owner>__<repo>__failed__<job>.log` | No |
| Original excerpts | Can be cut again from those logs, using the line ranges below | No |
| Sanitized excerpts | The `.log` files in this folder | Yes |

- Lines are the raw bytes from the log, including timestamps and color codes.
- Most files join several slices of one log, so line numbers here are not the
  original line numbers. The table lists the original ranges, in order.
- `SHA256SUMS` holds the checksum of each file here. It shows the files have not
  changed. It does not show they are safe or that they reproduce a behaviour: the
  tests do that.
- The job links stop working once GitHub deletes the logs. The commit and file
  paths do not expire.

## Sources

| File | Repository | Commit | Run / job | Original lines |
| --- | --- | --- | --- | --- |
| `pytest-sentry-flakes-trailing-services.log` | getsentry/sentry | `41404ca1e88f` | [41940071909 / 126958428549](https://github.com/getsentry/sentry/actions/runs/41940071909/job/126958428549) | 1946-1978, 2387 |
| `pytest-collection-error-short-header.log` | pytest-dev/pytest | `d4708376aa88` | [41678445995 / 126066692452](https://github.com/pytest-dev/pytest/actions/runs/41678445995/job/126066692452) | 685-703 |
| `pytest-nested-session.log` | pytest-dev/pytest | `0d98bbd7fd58` | [41496369554 / 125453437163](https://github.com/pytest-dev/pytest/actions/runs/41496369554/job/125453437163) | 676-694, 2045-2078, 3404-3409, 4766-4769 |
| `pytest-separators-captured-output.log` | psf/requests | `a42344e766bc` | [32753542817 / 97515783804](https://github.com/psf/requests/actions/runs/32753542817/job/97515783804) | 308-316, 533-552, 798-806 |
| `pytest-repeated-failures-section.log` | apache/airflow | `bb6bef2e402f` | [41937554355 / 126956518739](https://github.com/apache/airflow/actions/runs/41937554355/job/126956518739) | 13902, 14713-14720, 15004-15012, 15073-15075, 15594, 15713, 15738-15745, 16029-16037, 16098-16100, 16619, 16738 |
| `jest-console-under-fail-then-pass.log` | grafana/grafana | `eed84de802f8` | [41925827109 / 126912132331](https://github.com/grafana/grafana/actions/runs/41925827109/job/126912132331) | 2272-2282, 2305-2315, 2331-2337, 2463-2475, 2491-2502 |
| `jest-console-under-pass.log` | strapi/strapi | `ea1788fdd44e` | [41897786318 / 126815119824](https://github.com/strapi/strapi/actions/runs/41897786318/job/126815119824) | 2370-2377 |
| `jest-validation-warning-nested-output.log` | jestjs/jest | `72614448ecb9` | [41633081566 / 125907554046](https://github.com/jestjs/jest/actions/runs/41633081566/job/125907554046) | 245-262, 358-409 |
| `playwright-retries-then-trailing-network-error.log` | n8n-io/n8n | `a79aac7f9791` | [41953921653 / 127004898784](https://github.com/n8n-io/n8n/actions/runs/41953921653/job/127004898784) | 713-716, 4829-4845, 4870-4882, 4911-4922, 4950-4964, 4996-5005, 5039 |
| `playwright-spinner-bullets-and-items.log` | strapi/strapi | `06c043e39e16` | [41845686074 / 126631617867](https://github.com/strapi/strapi/actions/runs/41845686074/job/126631617867) | 445-448, 5724-5750 |
| `playwright-load-failure.log` | strapi/strapi | `89d7da4ca552` | [41849189281 / 126649691810](https://github.com/strapi/strapi/actions/runs/41849189281/job/126649691810) (attempt 2) | 1124-1135, 1147-1154 |
| `unknown-format-shell-script.log` | n8n-io/n8n | `aeb926e7fee6` | [41941465560 / 126963617433](https://github.com/n8n-io/n8n/actions/runs/41941465560/job/126963617433) | 1306-1309, 1322-1327 |
| `unknown-format-signal-among-passing-tests.log` | apache/airflow | `adb6effc4fbd` | [41923979955 / 126912028150](https://github.com/apache/airflow/actions/runs/41923979955/job/126912028150) (attempt 2) | 1733-1742 |

Commits are shortened here. Each is the commit the job ran on, taken from the
GitHub API when the logs were collected.

## Edits

Three edits were made, each removing a detail the test does not need:

- `playwright-retries-then-trailing-network-error.log`: the storage hostname on the
  last line is replaced with `example.invalid`. That domain is reserved and can
  never resolve. An earlier placeholder, `example-storage.blob.core.windows.net`,
  looked like a real Azure hostname and was changed after review.
- `pytest-sentry-flakes-trailing-services.log`: the database constraint name is
  replaced with `example_unique_constraint`. The rule matches the message, not the
  name.
- `jest-console-under-fail-then-pass.log`: the self-hosted runner path
  `/opt/actions-runner/_work` is replaced with `/home/runner/work`, in both copies
  of the failure, so they stay identical.

Kept on purpose: the two n8n test titles in
`playwright-retries-then-trailing-network-error.log`. Both are in n8n's public
source at the commit the job ran on, `a79aac7f9791ae9dc9d1c53a11c878521982e727`:

| Title | File | Line |
| --- | --- | --- |
| `Instance AI background lifecycle` › `should recover when a background builder task is cancelled` | `packages/quality/testing/playwright/tests/e2e/instance-ai/instance-ai-background-lifecycle.spec.ts` | 8, 14 |
| `n8n Assistant self-hosted onboarding @db:reset` › `should keep the search step open when verification fails` | `packages/quality/testing/playwright/tests/e2e/instance-ai/instance-ai-onboarding.spec.ts` | 17, 34 |

## Behaviour

"Today" is the output of the parser at `09edb7c`, checked after the edits. Each
file has a test asserting the target, not a full snapshot. "After step 7" is
the output with steps 1 to 7 implemented: verdict and reason per result, then
the signals that decided nothing (`rule x count @ first line`).

| File | Today | Target | After step 7 |
| --- | --- | --- | --- |
| `pytest-sentry-flakes-trailing-services.log` | 2 results, `unique-constraint-pollution` | `FLAKES` entries create no observation. The postgres line after the summary is a top level unattributed signal and decides no verdict | 1 result, UNVERIFIED (no-rule-matched); `unique-constraint-pollution` x1 @34 |
| `pytest-collection-error-short-header.log` | `dns-resolution` | The short header is found, phase `collection`, and the block ends before `generated xml file`. The DNS match stays until the rule is fixed in step 3 | 1 result, `dns-resolution`, phase collection (rule fix pending) |
| `pytest-nested-session.log` | 4 results | One outer failure. The nested session inside it creates no observations | 1 result, UNVERIFIED (no-rule-matched) |
| `pytest-separators-captured-output.log` | 1 result | `_ _ _ _` lines are not headers, and captured output is context, not primary evidence | 1 result, UNVERIFIED (no-rule-matched), captured output as context |
| `pytest-repeated-failures-section.log` | 4 results | 2 failures plus 2 merge diagnostics, because the second `FAILURES` section follows the closing line with no new session start | 2 results, both UNVERIFIED (no-rule-matched); 2 `duplicate-failure-block` |
| `jest-console-under-fail-then-pass.log` | 3 results | `Console` is not a failure, the block ends at the later `PASS`, and the summary repeat is merged. This excerpt has no rule match to begin with: the `grafana` locator signal is elsewhere in that job's log, not in these lines | 1 result, UNVERIFIED (no-rule-matched); `jest-console-block`, `duplicate-failure-block` |
| `jest-console-under-pass.log` | 1 result | No Jest failure. The `Console` block is a diagnostic. With no failure structure found, the log stays one unknown observation, as for any unknown format | 1 result, UNVERIFIED (boundary-unknown); `jest-console-block` |
| `jest-validation-warning-nested-output.log` | 5 results | `Validation Warning` is not a failure, and indented nested `FAIL` lines stay inside the outer block | 1 result, UNVERIFIED (no-rule-matched); 2 `jest-validation-warning-block` |
| `playwright-retries-then-trailing-network-error.log` | 4 results, `network-reset` | Shell `124)` lines are not items, retries are attempts, and `ECONNRESET` after the count lines is a top level unattributed signal | 2 results, both UNVERIFIED (no-rule-matched); `network-reset` x1 @72; 2 `playwright-item-rejected` |
| `playwright-spinner-bullets-and-items.log` | 2 Jest results | Read as Playwright. Spinner `●` lines are not Jest failures | 1 Playwright result, UNVERIFIED (no-rule-matched) |
| `playwright-load-failure.log` | 1 generic result | `boundary: "unknown"`, with no invented test name | 1 result, UNVERIFIED (boundary-unknown) |
| `unknown-format-shell-script.log` | `resource-exhaustion` | `boundary: "unknown"`. `out of memory` is an unattributed signal and decides no verdict | 1 result, UNVERIFIED (boundary-unknown); `resource-exhaustion` x1 @3 |
| `unknown-format-signal-among-passing-tests.log` | `network-reset` | `boundary: "unknown"`. `socket hang up` is an unattributed signal and decides no verdict | 1 result, UNVERIFIED (boundary-unknown); `network-reset` x1 @4 |
