# Contributing to flaky-finder

Thanks for helping out. This project is small on purpose, so please read
this short guide before opening a PR.

## The one rule that matters most

flaky-finder must never claim more than a log can establish. Every rule
reports **what text is present**, not why a test failed. If a change makes
output sound more certain than the evidence allows, it will be pushed back
on, however useful it seems. See "What each status means, exactly" and
"Limitations" in the [README](README.md).

## Setup

Requires Node.js >= 22.5.0.

```bash
npm install
npm test
```

## Before you open a PR

Run the same checks CI runs:

```bash
npm run typecheck
npm run lint
npm run format:check   # or `npm run format` to fix
npm run coverage       # runs the tests; fails if coverage drops below 70%
```

## Common contributions

### Adding or changing a rule (`src/rules.ts`)

- Match a **specific, well-known** non-product signature, never a bare
  assertion mismatch.
- Put it in the right place in `RULES`: order is precedence, most
  unambiguous signature first.
- Choose `matchStrength` honestly (`exact` / `strong` / `weak`).
- Bump `RULESET_VERSION` if you change any existing rule's pattern,
  verdict, or match strength.
- Add tests in `tests/rules.test.ts`: one that matches and, where it
  makes sense, one that should *not* match.

### Adding a framework parser (`src/parser.ts`)

- Add one parse function and a representative sample log in `fixtures/`.
- Add tests in `tests/parser.test.ts`.
- Say what the parser does *not* handle (retries, skips after setup
  failure, and so on) in the README's Limitations section.

## Pull requests

- Keep each PR focused on one change.
- Fill in the PR template, especially the "what this does not establish"
  part when it applies.
- Update the README if behavior or output changes.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
