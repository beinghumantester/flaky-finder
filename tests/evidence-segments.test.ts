import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSegments } from "../src/evidence-segments.js";

// The segment model from docs/design/failure-evidence-boundaries.md: primary
// evidence is whatever part of a block is not context, in log order, with a gap
// wherever context sits. Lines 100 to 150 with captured output at 120 to 140 give
// two segments, 100 to 119 and 141 to 150.

const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);

test("a block with no context is one segment covering the whole block", () => {
  assert.deepEqual(buildSegments(lines, { startLine: 3, endLine: 5 }, []), [
    { startLine: 3, endLine: 5, text: "line 3\nline 4\nline 5" },
  ]);
});

test("context in the middle of a block gives primary evidence on both sides, with their own lines", () => {
  const segments = buildSegments(lines, { startLine: 2, endLine: 10 }, [{ startLine: 5, endLine: 7 }]);
  assert.deepEqual(segments, [
    { startLine: 2, endLine: 4, text: "line 2\nline 3\nline 4" },
    { startLine: 8, endLine: 10, text: "line 8\nline 9\nline 10" },
  ]);
});

test("context that runs to the end of the block leaves one segment before it", () => {
  assert.deepEqual(buildSegments(lines, { startLine: 1, endLine: 6 }, [{ startLine: 4, endLine: 6 }]), [
    { startLine: 1, endLine: 3, text: "line 1\nline 2\nline 3" },
  ]);
});

test("two context spans give three segments, and trailing blank lines inside a segment are kept out of its text", () => {
  const withBlank = [...lines];
  withBlank[3] = "";
  const segments = buildSegments(withBlank, { startLine: 1, endLine: 12 }, [
    { startLine: 5, endLine: 6 },
    { startLine: 9, endLine: 9 },
  ]);
  assert.deepEqual(
    segments.map((s) => [s.startLine, s.endLine]),
    [
      [1, 3],
      [7, 8],
      [10, 12],
    ],
  );
  assert.equal(segments[0].text, "line 1\nline 2\nline 3");
});

test("a block that is all context has no primary segment", () => {
  assert.deepEqual(buildSegments(lines, { startLine: 2, endLine: 4 }, [{ startLine: 2, endLine: 4 }]), []);
});
