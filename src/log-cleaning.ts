// Real CI logs are rarely the clean text a test runner prints to a local
// terminal. GitHub Actions and GitLab both force color output on by default
// (so every line can carry ANSI escape codes), and a log downloaded from the
// GitHub Actions UI/API prefixes every line with an ISO-8601 timestamp. The
// block splitters in parser.ts are anchored to line starts (`^_{5,}`,
// `^\s*●`, `^\s*\d+\)`), so either one silently breaks detection: the log
// falls through to "unrecognized-log-format" and every failure in it is
// reported as one. Cleaning happens once, before any parsing, so no parser
// has to know about it.

// Cleaning must keep lines one to one: failure evidence records line numbers,
// and a cleaned line index is only a valid original line number while no line
// is added or removed. Nothing here may match across a newline.

// CSI sequences (colors, cursor movement: ESC [ ... final-byte) and OSC
// sequences (e.g. hyperlinks: ESC ] ... BEL or ESC \). An OSC sequence stops at
// a line end, so an unterminated one can't swallow the lines after it.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\r\n]*(?:\x07|\x1b\\)/g;

// Exactly the shape GitHub Actions prepends to downloaded log lines, e.g.
// "2026-11-03T05:27:43.1234567Z ". Only stripped at the very start of a line,
// so a timestamp that's part of a test's own output is left alone.
const CI_TIMESTAMP_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /gm;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// GitHub Actions logs start with a byte order mark, and a log joined from parts
// can have one at the start of a later line. Either hides that line's timestamp.
// Only a mark at a line start is removed; one inside a line is kept.
const LINE_START_BOM_RE = /^\ufeff/gm;

/**
 * Normalizes line endings, removes byte order marks at the start of any line,
 * then removes ANSI escape codes and CI timestamp prefixes, in that order. Line
 * count is preserved.
 */
export function cleanLog(raw: string): string {
  const lf = raw.replace(/\r\n/g, "\n");
  return stripAnsi(lf.replace(LINE_START_BOM_RE, "")).replace(CI_TIMESTAMP_PREFIX_RE, "");
}
