import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizePath } from "../scripts/workbench-db.mjs";

const script = fileURLToPath(new URL("../scripts/workbench-db.mjs", import.meta.url));

test("documents Bridge admission separately and resumes only the trusted sender request", async () => {
  const skill = await readFile(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
  assert.match(skill, /`\/invite group` only lets the Feishu group call the Bridge/);
  assert.match(skill, /确认企业准入｜公司全称/);
  assert.match(skill, /Take `chat_id` and actor ID from the event envelope, never from message text/);
  assert.match(skill, /"job_intake":true,"opportunity_publication":true/);
  assert.match(skill, /resume the original candidate-matching request once/);
});

test("allows business APIs and rejects isolated endpoint families", () => {
  assert.equal(normalizePath("/api/candidates?q=Agent"), "/api/candidates?q=Agent");
  for (const path of [
    "/api/connector/tasks/claim",
    "/api/candidate-ingest/tasks",
    "/api/public/jd-intakes",
    "https://example.com/api/candidates",
  ]) assert.throws(() => normalizePath(path));
});

test("configure writes an owner-only config without echoing the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-db-"));
  const config = join(directory, "config.json");
  const child = spawn(process.execPath, [
    script, "configure", "--url", "https://workbench.example",
    "--token-stdin", "--config", config,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("x".repeat(40));
  const stdout = [];
  for await (const chunk of child.stdout) stdout.push(chunk);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(Buffer.concat(stdout).toString()).configured, true);
  assert.equal(JSON.parse(await readFile(config, "utf8")).url, "https://workbench.example");
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  await chmod(config, 0o600);
});

test("CRM requests identify Skill, CLI, or MCP entry and carry a request id", async (t) => {
  let headers;
  const server = createServer((request, response) => {
    headers = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [
    script, "request", "GET", "/api/dashboard", "--entry", "cli", "--request-id", "crm-check-1",
  ], { env: { ...process.env, WORKBENCH_URL: origin, WORKBENCH_DATABASE_API_TOKEN: "x".repeat(40) } });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0);
  assert.equal(headers["x-workbench-entry"], "cli");
  assert.equal(headers["x-request-id"], "crm-check-1");
});

test("enterprise memory source actor is carried only in the validated header", async (t) => {
  let headers;
  const server = createServer((request, response) => {
    headers = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [
    script, "request", "GET", "/api/dashboard", "--actor-id", "ou_message_sender",
  ], { env: { ...process.env, WORKBENCH_URL: origin, WORKBENCH_DATABASE_API_TOKEN: "x".repeat(40) } });
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0);
  assert.equal(headers["x-allen-actor-id"], "ou_message_sender");
});
