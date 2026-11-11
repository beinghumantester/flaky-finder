import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFailures } from "../src/parser.js";

// End to end: the real CLI in a child process, and a real local HTTP server where
// the LLM provider would be, so the request body inspected is the one that would
// leave the process. These prove the properties of the whole tool, not of one
// extractor: what can decide a verdict, what is sent, and what is printed.

interface Captured {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function provider(reply: {
  status: number;
  body: string;
}): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const okReply = (verdict: string, explanation = "model says so") =>
  ({
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdict, confidence: "low", explanation }) } }],
    }),
  }) as const;

// Asynchronous on purpose: the provider server above lives in this process, and a
// synchronous spawn would block the event loop, so the server could never answer
// the child's request.
async function run(logText: string, args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flaky-finder-pipeline-"));
  const file = join(dir, "ci.log");
  writeFileSync(file, logText);
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "analyze", file, ...args], {
        env: {
          ...process.env,
          FLAKY_FINDER_API_KEY: "",
          FLAKY_FINDER_RULES_FILE: "",
          FLAKY_FINDER_BASE_URL: "http://127.0.0.1:9/v1",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Out {
  schemaVersion: number;
  results: {
    testName: string;
    framework: string;
    verdict: string;
    source: string;
    ruleId?: string;
    abstainReason?: string;
    explanation: string;
    evidenceLocation?: { startLine: number; endLine: number };
    unattributedSignals?: { ruleId: string; line: number; where: string }[];
    extraction?: { boundary: string; span: { startLine: number; endLine: number } };
    segments?: unknown[];
  }[];
  unattributedSignals: { ruleId: string; count: number; firstLine: number }[];
  diagnostics: { code: string; line?: number; message: string; text?: unknown }[];
}

async function runJson(logText: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = await run(logText, ["--json", ...args], env);
  assert.equal(r.code, 0, r.stderr);
  return { ...r, out: JSON.parse(r.stdout) as Out };
}

const PY_SUMMARY = "=========================== short test summary info ============================";
const PW_ITEM = "  1) [chromium] › login.spec.ts:10:5 › user can log in";

// ---- 1, 2: ineligible evidence decides nothing and is never sent ----

test("a truncated Playwright failure containing ECONNRESET is UNVERIFIED (boundary-truncated), the signal is listed, and no LLM request is made", async () => {
  const p = await provider(okReply("ENVIRONMENT_SIGNAL_DETECTED"));
  try {
    const { out } = await runJson([PW_ITEM, "    Error: read ECONNRESET", ""].join("\n"), ["--llm"], {
      FLAKY_FINDER_BASE_URL: p.url,
    });
    assert.equal(out.results[0].verdict, "UNVERIFIED");
    assert.equal(out.results[0].abstainReason, "boundary-truncated");
    assert.deepEqual(
      out.results[0].unattributedSignals?.map((u) => [u.ruleId, u.where]),
      [["network-reset", "ineligible-block"]],
    );
    assert.equal(out.unattributedSignals[0]?.ruleId, "network-reset");
    assert.equal(p.requests.length, 0);
  } finally {
    await p.close();
  }
});

test("an unknown-format log containing ECONNRESET is UNVERIFIED (boundary-unknown) and no LLM request is made", async () => {
  const p = await provider(okReply("ENVIRONMENT_SIGNAL_DETECTED"));
  try {
    const { out } = await runJson("npm install\nread ECONNRESET\n", ["--llm"], { FLAKY_FINDER_BASE_URL: p.url });
    assert.equal(out.results[0].abstainReason, "boundary-unknown");
    assert.equal(out.results[0].verdict, "UNVERIFIED");
    assert.equal(out.unattributedSignals[0]?.ruleId, "network-reset");
    assert.equal(p.requests.length, 0);
  } finally {
    await p.close();
  }
});

// ---- 3, 9: context cannot decide, and is never sent ----

const CONTEXT_LOG = [
  "=== FAILURES ===",
  "___ test_checkout ___",
  "E   AssertionError: expected 200, got 400",
  "--- Captured stderr call ---",
  "ConnectionResetError: connection reset by peer CTX_MARKER",
  PY_SUMMARY,
  "",
].join("\n");

test("a signature only in captured output gives UNVERIFIED (context-only-signal) with the signal listed, LLM off", async () => {
  const { out } = await runJson(CONTEXT_LOG);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].verdict, "UNVERIFIED");
  assert.equal(out.results[0].abstainReason, "context-only-signal");
  assert.deepEqual(
    out.results[0].unattributedSignals?.map((u) => [u.ruleId, u.line, u.where]),
    [["network-reset", 5, "context"]],
  );
});

test("with --llm, the request for that failure carries its primary evidence only: the captured output is not in the body", async () => {
  const p = await provider(okReply("UNVERIFIED", "cannot tell"));
  try {
    const { out } = await runJson(CONTEXT_LOG, ["--llm"], { FLAKY_FINDER_BASE_URL: p.url });
    assert.equal(p.requests.length, 1);
    const body = p.requests[0].body;
    assert.ok(body.includes("AssertionError: expected 200, got 400"));
    assert.ok(!body.includes("CTX_MARKER"));
    assert.ok(!body.includes("ConnectionResetError"));
    assert.ok(!body.includes("short test summary info"), "the full log is not sent");
    assert.equal(out.results[0].abstainReason, "insufficient-evidence");
    assert.equal(out.results[0].source, "llm");
  } finally {
    await p.close();
  }
});

// ---- 4: a mixed log ----

test("a pytest failure and a Playwright failure in one log are both extracted and classified independently", async () => {
  const { out } = await runJson(
    [
      "=== FAILURES ===",
      "___ test_a ___",
      "E   ECONNRESET",
      PY_SUMMARY,
      "",
      PW_ITEM,
      "    Error: Target closed",
      "  1 failed",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    out.results.map((r) => [r.framework, r.ruleId]),
    [
      ["pytest", "network-reset"],
      ["playwright", "locator-target-closed"],
    ],
  );
});

// ---- 8: a match in primary evidence carries its location ----

test("a rule match in primary evidence gives the verdict and the evidence's original line number", async () => {
  const { out } = await runJson(
    ["noise", "=== FAILURES ===", "___ test_a ___", "x", "E   ECONNRESET", PY_SUMMARY, ""].join("\n"),
  );
  assert.equal(out.results[0].ruleId, "network-reset");
  assert.deepEqual(out.results[0].evidenceLocation, { startLine: 5, endLine: 5 });
  assert.deepEqual(out.results[0].extraction?.span, { startLine: 3, endLine: 5 });
});

// ---- 10: one bad observation does not stop the others ----

test("one ineligible failure next to one eligible failure: the eligible one is classified normally, and the command succeeds", async () => {
  const { out, code } = await runJson(
    ["=== FAILURES ===", "___ test_a ___", "E   ECONNRESET", PY_SUMMARY, PW_ITEM, "    Error: cut off"].join("\n"),
  );
  assert.equal(code, 0);
  assert.deepEqual(
    out.results.map((r) => [r.verdict, r.abstainReason]),
    [
      ["ENVIRONMENT_SIGNAL_DETECTED", undefined],
      ["UNVERIFIED", "boundary-truncated"],
    ],
  );
});

test("an unreachable LLM endpoint affects only the failures that needed it: llm-unavailable, no endpoint in the explanation, exit 0, count in the text summary", async () => {
  const log = [
    "=== FAILURES ===",
    "___ test_a ___",
    "E   ECONNRESET",
    "___ test_b ___",
    "E   assert 1 == 2",
    PY_SUMMARY,
    "",
  ].join("\n");
  const { out } = await runJson(log, ["--llm"]); // base URL points at a closed port
  assert.equal(out.results[0].ruleId, "network-reset");
  assert.equal(out.results[1].abstainReason, "llm-unavailable");
  assert.ok(!out.results[1].explanation.includes("127.0.0.1"));
  assert.ok(!/:9\b/.test(out.results[1].explanation));
  const text = await run(log, ["--llm"]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /LLM unavailable for 1 of 2 failure\(s\)/);
});

// ---- opt-in and disclosure ----

const UNMATCHED = ["=== FAILURES ===", "___ test_a ___", "E   assert 1 == 2", PY_SUMMARY, ""].join("\n");

test("a configured key without --llm makes no request and says so; --llm without a key makes the request without an Authorization header, after a warning", async () => {
  const p = await provider(okReply("UNVERIFIED"));
  try {
    const keyOnly = await run(UNMATCHED, ["--json"], { FLAKY_FINDER_API_KEY: "k", FLAKY_FINDER_BASE_URL: p.url });
    assert.equal(p.requests.length, 0);
    assert.match(keyOnly.stderr, /--llm was not given, so the LLM step is off/);
    assert.equal(JSON.parse(keyOnly.stdout).llmFallback, false);

    const flagOnly = await run(UNMATCHED, ["--json", "--llm"], { FLAKY_FINDER_BASE_URL: p.url });
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0].headers.authorization, undefined);
    assert.match(flagOnly.stderr, /FLAKY_FINDER_API_KEY is not set/);
    assert.equal(JSON.parse(flagOnly.stdout).llmFallback, true);

    await run(UNMATCHED, ["--json", "--llm"], { FLAKY_FINDER_API_KEY: "k-1", FLAKY_FINDER_BASE_URL: p.url });
    assert.equal(p.requests[1].headers.authorization, "Bearer k-1");
  } finally {
    await p.close();
  }
});

test("the endpoint host is disclosed on stderr before anything is sent", async () => {
  const p = await provider(okReply("UNVERIFIED"));
  try {
    const { stderr } = await run(UNMATCHED, ["--llm"], { FLAKY_FINDER_BASE_URL: p.url });
    assert.ok(stderr.includes(`will be sent to ${new URL(p.url).host}`), stderr);
  } finally {
    await p.close();
  }
});

test("--help documents --llm as off by default and as sending log text", async () => {
  const { stdout } = await run("", ["--help"]);
  assert.match(stdout, /--llm/);
  assert.match(stdout, /Off by default/);
});

// ---- 7: what extraction rejected stays internal ----

const SECRET_LOG = [
  "    124) echo Authorization: Bearer SECRET_BEARER_1 ;;",
  "    137) echo postgres://admin:SECRET_PW_2@db.internal/app ;;",
  "    138) echo https://svc:SECRET_URL_3@intra.corp.example/x ;;",
  "    139) echo host SECRET_HOST_4.internal.corp ;;",
  "=== FAILURES ===",
  "___ test_a ___",
  "E   ECONNRESET",
  "--- Captured stdout call ---",
  "token=SECRET_CAPTURED_5",
  "___ test_b ___",
  "E   ECONNRESET",
  PY_SUMMARY,
  "",
].join("\n");
const SECRETS = [
  "SECRET_BEARER_1",
  "SECRET_PW_2",
  "SECRET_URL_3",
  "SECRET_HOST_4",
  "SECRET_CAPTURED_5",
  "SECRET_ECHO_6",
];

test("internally, the extraction result keeps the rejected text and the captured output", async () => {
  const { failures, diagnostics } = extractFailures(SECRET_LOG);
  const internal = [
    ...diagnostics.map((d) => d.text ?? ""),
    ...failures.flatMap((f) => (f.extraction?.contextSpans ?? []).map((c) => c.text)),
  ].join("\n");
  for (const s of SECRETS.slice(0, 5)) assert.ok(internal.includes(s), s);
});

test("publicly, none of it reaches the text output, the JSON output, the grouping section, or the output of a provider error that echoes the request", async () => {
  const p = await provider({
    status: 500,
    body: JSON.stringify({ error: "bad request: SECRET_ECHO_6 " + "Authorization: Bearer SECRET_BEARER_1" }),
  });
  try {
    for (const args of [[], ["--json"], ["--llm"], ["--json", "--llm"]]) {
      const r = await run(SECRET_LOG, args, { FLAKY_FINDER_BASE_URL: p.url });
      assert.equal(r.code, 0);
      for (const s of SECRETS) {
        assert.ok(!r.stdout.includes(s), `${s} in stdout of ${args.join(" ") || "text"}`);
        assert.ok(!r.stderr.includes(s), `${s} in stderr of ${args.join(" ") || "text"}`);
      }
    }
    const text = await run(SECRET_LOG, []);
    assert.match(text.stdout, /Failure signature groups/, "the grouping section was exercised");
    assert.match(text.stdout, /Declined by extraction \(4 line/);
    const { out } = await runJson(SECRET_LOG);
    assert.equal(out.diagnostics.length, 4);
    for (const d of out.diagnostics) assert.equal("text" in d, false);
  } finally {
    await p.close();
  }
});

// ---- JSON v2 shape ----

test("JSON v2: top-level and per-result structure, for a rule result, an abstention, and an ineligible block", async () => {
  const { out } = await runJson(
    [
      "=== FAILURES ===",
      "___ test_a ___",
      "E   ECONNRESET",
      "___ test_b ___",
      "E   assert 1",
      PY_SUMMARY,
      PW_ITEM,
      "    cut",
    ].join("\n"),
  );
  assert.equal(out.schemaVersion, 2);
  assert.deepEqual(Object.keys(out).sort(), [
    "customRules",
    "diagnostics",
    "failureGroups",
    "input",
    "llmFallback",
    "results",
    "schemaVersion",
    "summary",
    "tool",
    "unattributedSignals",
  ]);
  const [rule, none, cut] = out.results;
  assert.deepEqual(Object.keys(rule).sort(), [
    "alsoMatched",
    "category",
    "confidence",
    "evidenceLine",
    "evidenceLocation",
    "explanation",
    "extraction",
    "framework",
    "ruleId",
    "ruleOrigin",
    "segments",
    "source",
    "testName",
    "unattributedSignals",
    "verdict",
  ]);
  assert.deepEqual(Object.keys(none).sort(), [
    "abstainReason",
    "confidence",
    "explanation",
    "extraction",
    "framework",
    "segments",
    "source",
    "testName",
    "unattributedSignals",
    "verdict",
  ]);
  assert.equal(cut.extraction?.boundary, "truncated");
  assert.deepEqual(Object.keys(cut.extraction!).sort(), ["boundary", "method", "phase", "span"]);
});

test("JSON v2: an empty log is one unknown observation with no evidence, no signals and no diagnostics", async () => {
  const { out } = await runJson("");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].abstainReason, "boundary-unknown");
  assert.deepEqual(out.results[0].segments, []);
  assert.deepEqual(out.unattributedSignals, []);
  assert.deepEqual(out.diagnostics, []);
});
