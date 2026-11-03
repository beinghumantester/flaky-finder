// Real CI logs are rarely the clean text a test runner prints to a local
// terminal. GitHub Actions and GitLab both force color output on by default
// (so every line can carry ANSI escape codes), and a log downloaded from the
// GitHub Actions UI/API prefixes every line with an ISO-8601 timestamp. The
// block splitters in parser.ts are anchored to line starts (`^_{5,}`,
// `^\s*●`, `^\s*\d+\)`), so either one silently breaks detection: the log
// falls through to "unrecognized-log-format" and every failure in it is
// reported as one. Cleaning happens once, before any parsing, so no parser
// has to know about it.

// CSI sequences (colors, cursor movement: ESC [ ... final-byte) and OSC
// sequences (e.g. hyperlinks: ESC ] ... BEL or ESC \).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Exactly the shape GitHub Actions prepends to downloaded log lines, e.g.
// "2026-11-03T05:27:43.1234567Z ". Only stripped at the very start of a line,
// so a timestamp that's part of a test's own output is left alone.
const CI_TIMESTAMP_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /gm;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Normalizes line endings, then removes ANSI escape codes and CI timestamp prefixes. */
export function cleanLog(raw: string): string {
  return stripAnsi(raw.replace(/\r\n/g, "\n")).replace(CI_TIMESTAMP_PREFIX_RE, "");
}
