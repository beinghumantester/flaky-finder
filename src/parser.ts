import type { Failure } from "./types.js";

function parsePytest(raw: string): Failure[] {
  // Each failure block is framed by a line of underscores holding the test name:
  // ____________________________ test_name ____________________________
  const blocks = raw.split(/\n(?=_{5,}\s)/);
  const failures: Failure[] = [];
  for (const block of blocks) {
    const header = block.match(/^_{5,}\s+(.+?)\s+_{5,}/m);
    if (!header) continue;
    failures.push({ testName: header[1].trim(), framework: "pytest", rawText: block });
  }
  return failures;
}

function parseJest(raw: string): Failure[] {
  // Each failure is introduced by a line starting with "  ● <describe> › <test>"
  const blocks = raw.split(/\n(?=\s*●\s)/);
  const failures: Failure[] = [];
  for (const block of blocks) {
    const header = block.match(/^\s*●\s+(.+)$/m);
    if (!header) continue;
    failures.push({ testName: header[1].trim(), framework: "jest", rawText: block });
  }
  return failures;
}

function parsePlaywright(raw: string): Failure[] {
  // Each failure is a numbered entry: "  1) [chromium] › login.spec.ts:10:5 › user can log in"
  const blocks = raw.split(/\n(?=\s*\d+\)\s)/);
  const failures: Failure[] = [];
  for (const block of blocks) {
    const header = block.match(/^\s*\d+\)\s+(.+)$/m);
    if (!header) continue;
    failures.push({ testName: header[1].trim(), framework: "playwright", rawText: block });
  }
  return failures;
}

/**
 * Detects the CI tool by its distinctive markers and delegates to that
 * framework's parser. Falls back to treating the whole input as one
 * failure rather than guessing at a format it doesn't recognize.
 */
export function parseLog(raw: string): Failure[] {
  if (/^_{5,}\s+\S.*\s+_{5,}\s*$/m.test(raw)) return parsePytest(raw);
  if (/^\s*●\s/m.test(raw)) return parseJest(raw);
  if (/^\s*\d+\)\s+.*›/m.test(raw)) return parsePlaywright(raw);
  return [{ testName: "unrecognized-log-format", framework: "generic", rawText: raw }];
}
