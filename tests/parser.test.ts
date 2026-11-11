import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLog } from "../src/parser.js";

test("parses pytest FAILURES block into two failures with correct names", () => {
  const raw = readFileSync("fixtures/pytest-sample.log", "utf8");
  const failures = parseLog(raw);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].framework, "pytest");
  assert.equal(failures[0].testName, "test_fetch_user_retries");
  assert.equal(failures[1].testName, "test_discount_calculation");
});

test("parses jest ● blocks into two failures with correct names", () => {
  const raw = readFileSync("fixtures/jest-sample.log", "utf8");
  const failures = parseLog(raw);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].framework, "jest");
  assert.equal(failures[0].testName, "Cart › retries fetch on reset connection");
});

test("parses playwright numbered failures into two failures with correct names", () => {
  const raw = readFileSync("fixtures/playwright-sample.log", "utf8");
  const failures = parseLog(raw);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].framework, "playwright");
  assert.match(failures[0].testName, /login\.spec\.ts/);
});

test("an unrecognized format falls back to one generic failure instead of guessing a split", () => {
  const failures = parseLog("some random text that matches no known CI tool's output format");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].framework, "generic");
});
