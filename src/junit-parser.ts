// A small, deliberately non-general JUnit XML extractor — not a full XML
// parser. Same philosophy as parser.ts's regex-based log parsers: handle the
// common, well-formed case from real pytest/Jest/Playwright JUnit output
// honestly, and fail loudly and clearly on anything else rather than
// guessing. Pulling in a general-purpose XML library would let this silently
// handle inputs nobody has reviewed; a narrow extractor whose failure mode is
// "throws, or records a warning" is easier to audit.

export class JUnitParseError extends Error {}

export type JUnitCaseStatus = "PASSED" | "FAILED" | "SKIPPED";

export interface JUnitCase {
  name: string;
  /** null when the <testcase> had no classname attribute — see history-ingest.ts buildTestId for what that means for test identity. */
  classname: string | null;
  status: JUnitCaseStatus;
  /**
   * Text from the <failure>/<error> element (message attribute + inner body),
   * concatenated. null when the case didn't fail, or failed but the report
   * included no failure detail at all — callers must not guess evidence
   * that isn't there.
   */
  detail: string | null;
}

export interface JUnitParseResult {
  cases: JUnitCase[];
  /** Non-fatal issues: a <testcase> tag found but unusable (e.g. no name attribute), skipped rather than guessed at. */
  warnings: string[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint)) return match;
      try {
        // String.fromCodePoint throws RangeError for a numeric entity outside
        // the valid Unicode range (e.g. &#1114112;, above 0x10FFFF) — a
        // malformed/invalid entity must fall back to the literal text, not
        // crash the whole parse over one bad character reference.
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return ENTITIES[body] ?? match;
  });
}

function getAttr(tag: string, attr: string): string | null {
  // Matches attr="..." or attr='...'; JUnit writers don't emit unquoted attributes.
  const match = tag.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"|\\b${attr}\\s*=\\s*'([^']*)'`));
  if (!match) return null;
  return decodeXmlEntities(match[1] ?? match[2] ?? "");
}

const TESTCASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
// Only matches an UNPREFIXED <testcase> tag. A report using XML namespaces
// (e.g. <ns:testcase>) will match none of these and fall through to the
// "no <testsuite>/<testcase> found" error below — a loud, honest failure,
// not a silent zero-case result mistaken for "no tests ran."
const TESTCASE_TAG_COUNT_RE = /<testcase\b/g;
// <failure .../>, <failure ...>body</failure>, and the same for <error>.
const FAILURE_OR_ERROR_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;
const FAILURE_OR_ERROR_COUNT_RE = /<(?:failure|error)\b/g;
const SKIPPED_RE = /<skipped\b/;

/**
 * Extracts every <testcase> element from a JUnit XML report. Throws
 * JUnitParseError if the input doesn't look like a JUnit report at all
 * (no <testsuite> and no <testcase> anywhere) — that's a clear signal this
 * is the wrong file, not something to silently return zero results for.
 * A <testcase> missing its `name` attribute is skipped with a warning
 * rather than invented. A <testcase> that appears more than once with the
 * same name+classname (e.g. a report from a retry plugin) is NOT
 * deduplicated here — every occurrence becomes its own case, in document
 * order; history-ingest.ts records each as its own run under the same
 * run_id, which can itself produce an INTERMITTENCY_OBSERVED assessment
 * from a single CI job's internal retries, not just across separate jobs.
 */
export function parseJUnitXml(raw: string): JUnitParseResult {
  if (!/<testsuite\b/i.test(raw) && !/<testcase\b/i.test(raw)) {
    throw new JUnitParseError("Input does not contain a <testsuite> or <testcase> element — not a recognized JUnit XML report.");
  }

  const cases: JUnitCase[] = [];
  const warnings: string[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  TESTCASE_RE.lastIndex = 0;
  while ((match = TESTCASE_RE.exec(raw)) !== null) {
    index += 1;
    const [, openingAttrs, body] = match;
    const name = getAttr(openingAttrs, "name");
    if (!name) {
      warnings.push(`<testcase> #${index} has no name attribute — skipped rather than guessed.`);
      continue;
    }
    const classname = getAttr(openingAttrs, "classname");

    let status: JUnitCaseStatus = "PASSED";
    let detail: string | null = null;
    if (body) {
      const failureOrErrorCount = (body.match(FAILURE_OR_ERROR_COUNT_RE) ?? []).length;
      if (failureOrErrorCount > 1) {
        warnings.push(
          `<testcase name="${name}"> has ${failureOrErrorCount} <failure>/<error> elements — only the first (in document order) is used as evidence; the rest are not surfaced.`
        );
      }
      const failureMatch = body.match(FAILURE_OR_ERROR_RE);
      if (failureMatch) {
        status = "FAILED";
        const [, , failureAttrs, failureBody] = failureMatch;
        const message = getAttr(failureAttrs, "message");
        const bodyText = failureBody ? decodeXmlEntities(failureBody.trim()) : "";
        const combined = [message, bodyText].filter((part) => part && part.length > 0).join("\n");
        detail = combined.length > 0 ? combined : null;
      } else if (SKIPPED_RE.test(body)) {
        status = "SKIPPED";
      }
    }

    cases.push({ name, classname, status, detail });
  }

  // TESTCASE_RE requires a matching open/close pair (or a self-closing tag).
  // A truncated or otherwise malformed document can contain an opening
  // <testcase ...> that TESTCASE_RE never matches at all (no </testcase> and
  // no /> before the input ends) — that tag is invisible to the loop above,
  // so a raw count of <testcase occurrences catches it even though no
  // regex match failed loudly. This is a heuristic, not a real XML
  // well-formedness check, but it turns a silent "fewer tests than the file
  // actually lists" into a visible warning.
  const rawTestcaseTagCount = (raw.match(TESTCASE_TAG_COUNT_RE) ?? []).length;
  const unmatchedTagCount = rawTestcaseTagCount - index;
  if (unmatchedTagCount > 0) {
    warnings.push(
      `Found ${rawTestcaseTagCount} <testcase> opening tag(s) but only matched ${index} complete element(s) — ${unmatchedTagCount} may be truncated or malformed and were silently excluded.`
    );
  }

  return { cases, warnings };
}
