import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanLog, stripAnsi } from "../src/log-cleaning.js";
import { parseLog } from "../src/parser.js";
import { parseJUnitXml } from "../src/junit-parser.js";
import { classifyWithRules } from "../src/rules.js";

test("stripAnsi removes color/style codes and OSC hyperlinks, leaving the text", () => {
  assert.equal(stripAnsi("\x1b[31m\x1b[1mFAILED\x1b[0m"), "FAILED");
  assert.equal(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), "link");
  assert.equal(stripAnsi("\x1b[38;5;196mred\x1b[39m"), "red");
});

test("cleanLog strips GitHub Actions timestamp prefixes only at line start", () => {
  const raw = "2026-11-03T05:27:43.1234567Z line one\r\n2026-11-03T05:27:44Z created at 2026-11-03T05:27:44Z\r\n";
  assert.equal(cleanLog(raw), "line one\ncreated at 2026-11-03T05:27:44Z\n");
});

test("a GitHub Actions log with timestamps, colors and CRLF parses the same as the clean pytest log", () => {
  const clean = parseLog(readFileSync("fixtures/pytest-sample.log", "utf8"));
  const ci = parseLog(readFileSync("fixtures/github-actions-pytest.log", "utf8"));
  assert.equal(ci.length, 2);
  assert.deepEqual(
    ci.map((f) => [f.framework, f.testName]),
    clean.map((f) => [f.framework, f.testName]),
  );
});

test("evidence lines from a colored CI log contain no escape codes", () => {
  const [first] = parseLog(readFileSync("fixtures/github-actions-pytest.log", "utf8"));
  const result = classifyWithRules(first);
  assert.equal(result.ruleId, "network-reset");
  assert.ok(!(result.evidenceLine ?? "").includes("\x1b"));
});

test("jest and playwright block headers survive color codes", () => {
  const jest =
    "FAIL src/cart.test.js\n\x1b[1m\x1b[31m  ● Cart › adds item\x1b[39m\x1b[22m\n\n    expect(received).toBe(expected)\n";
  assert.equal(parseLog(jest)[0].testName, "Cart › adds item");
  const pw = "\x1b[31m  1) [chromium] › login.spec.ts:10:5 › user can log in\x1b[39m\n\n    Error: Timed out\n";
  assert.equal(parseLog(pw)[0].framework, "playwright");
});

test("JUnit failure text with encoded or raw escape codes reaches the rule engine as plain text", () => {
  const xml = `<testsuite><testcase classname="c" name="t"><failure message="&#27;[31mECONNRESET&#27;[0m">\x1b[1mboom\x1b[0m</failure></testcase></testsuite>`;
  const { cases } = parseJUnitXml(xml);
  assert.equal(cases[0].detail, "ECONNRESET\nboom");
});

// Failure evidence stores original line numbers, which is only safe while a
// cleaned line index still points at the same original line.
test("cleanLog never adds or removes lines", () => {
  const logs = [
    "a\nb\nc\n",
    "a\r\nb\r\nc\r\n",
    "﻿2026-11-03T05:27:43.1234567Z a\n2026-11-03T05:27:44Z b\n",
    "\x1b[31ma\x1b[0m\n\x1b]8;;https://example.com\x07b\x1b]8;;\x07\nc",
    // An unterminated OSC sequence must not swallow the lines after it.
    "a\n\x1b]8;;https://example.com\nb\nc\x07\nd\n",
    "\n\n\n",
    "",
  ];
  for (const log of logs) {
    assert.equal(cleanLog(log).split("\n").length, log.replace(/\r\n/g, "\n").split("\n").length, JSON.stringify(log));
  }
});

test("cleanLog keeps the text of lines after an unterminated OSC sequence", () => {
  const cleaned = cleanLog("a\n\x1b]8;;https://example.com\nb\nc\n").split("\n");
  assert.equal(cleaned[2], "b");
  assert.equal(cleaned[3], "c");
});

test("cleanLog removes a byte order mark, so line 1's timestamp is stripped too", () => {
  assert.equal(cleanLog("﻿2026-11-03T05:27:43.1234567Z first\nsecond\n"), "first\nsecond\n");
  assert.equal(cleanLog("﻿plain\n"), "plain\n");
});

// Real logs can be joined from parts, leaving a byte order mark at the start of a
// later line (apache/airflow job 126956518739, line 16099). Cleaning must treat
// every line start like line 1, and must not touch a mark inside a line.
test("cleanLog removes a byte order mark at the start of a later line, so its timestamp is stripped too", () => {
  const raw = "2026-11-03T05:27:43Z first\n﻿2026-11-03T05:27:44Z second\n2026-11-03T05:27:45Z third\n";
  assert.equal(cleanLog(raw), "first\nsecond\nthird\n");
});

test("cleanLog removes a byte order mark at the start of a line that follows a CRLF line ending", () => {
  assert.equal(cleanLog("first\r\n﻿2026-11-03T05:27:44Z second\r\n"), "first\nsecond\n");
});

test("cleanLog keeps a byte order mark that is inside a line, and still keeps the line count", () => {
  const raw = "a﻿b\n﻿c\n";
  const cleaned = cleanLog(raw);
  assert.equal(cleaned, "a﻿b\nc\n");
  assert.equal(cleaned.split("\n").length, raw.split("\n").length);
});

test("every bundled fixture keeps its line count through cleaning", () => {
  for (const file of ["pytest-sample.log", "jest-sample.log", "playwright-sample.log", "github-actions-pytest.log"]) {
    const raw = readFileSync(`fixtures/${file}`, "utf8");
    assert.equal(cleanLog(raw).split("\n").length, raw.split("\n").length, file);
  }
});
