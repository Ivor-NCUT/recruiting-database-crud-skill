#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const DENIED = ["/api/auth/", "/api/candidate-ingest/", "/api/connector/", "/api/public/"];

function fail(message) {
  throw new Error(message);
}

function emit(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function normalizeUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    fail("workbench URL must be an http(s) origin without a path");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    fail("workbench URL must be an http(s) origin without a path");
  }
  return url.origin;
}

export function normalizePath(value) {
  const raw = String(value).trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) fail("request path must be a relative API path");
  let url;
  try {
    url = new URL(raw, "https://workbench.invalid");
  } catch {
    fail("request path must be a relative API path");
  }
  if (url.origin !== "https://workbench.invalid" || url.hash) fail("request path must be a relative API path");
  if (url.pathname !== "/healthz" && !url.pathname.startsWith("/api/")) {
    fail("request path must start with /api/ or equal /healthz");
  }
  if (DENIED.some((prefix) => url.pathname.startsWith(prefix))) {
    fail("this service identity cannot call the requested endpoint family");
  }
  if (url.pathname.split("/").includes("..")) fail("request path cannot contain parent traversal");
  return `${url.pathname}${url.search}`;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${name} requires a value`);
  return args[index + 1];
}

function flag(args, name) {
  return args.includes(name);
}

function configPath(explicit) {
  if (explicit) return explicit;
  if (process.env.RECRUITING_DATABASE_CONFIG?.trim()) return process.env.RECRUITING_DATABASE_CONFIG.trim();
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "private", "recruiting-database-crud.json");
}

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString().trim();
}

async function configure(args) {
  const url = normalizeUrl(option(args, "--url") || fail("--url is required"));
  if (!flag(args, "--token-stdin")) fail("--token-stdin is required");
  const token = await stdin();
  if (token.length < 32) fail("database token must contain at least 32 characters");
  const path = configPath(option(args, "--config"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ url, token })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  emit({ configured: true, url, config: path });
}

async function loadConfig(explicit) {
  const url = process.env.WORKBENCH_URL?.trim();
  const token = process.env.WORKBENCH_DATABASE_API_TOKEN?.trim();
  if (url && token) return { url: normalizeUrl(url), token };
  const path = configPath(explicit);
  let payload;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read private config ${path}: ${error.message}`);
  }
  if (!payload.url || !payload.token) fail(`private config ${path} must contain url and token`);
  return { url: normalizeUrl(payload.url), token: String(payload.token) };
}

async function bodyFrom(args) {
  const inline = option(args, "--data");
  const file = option(args, "--file");
  if (inline !== undefined && file !== undefined) fail("--data and --file are mutually exclusive");
  if (inline === undefined && file === undefined) return undefined;
  const source = inline ?? await readFile(file, "utf8");
  try {
    return JSON.stringify(JSON.parse(source));
  } catch (error) {
    fail(`invalid JSON body: ${error.message}`);
  }
}

function quoteEtag(value) {
  const clean = String(value).trim().replace(/^"|"$/g, "");
  if (!clean || /["\r\n]/.test(clean)) fail("invalid If-Match value");
  return `"${clean}"`;
}

async function request(args) {
  const method = String(args[0] || "").toUpperCase();
  if (!METHODS.has(method)) fail("method must be GET, POST, PATCH, or DELETE");
  const path = normalizePath(args[1] || fail("request path is required"));
  const body = await bodyFrom(args);
  const dryRun = flag(args, "--dry-run");
  if (method === "GET" && body !== undefined) fail("GET requests cannot include a JSON body");
  if (method !== "GET" && !flag(args, "--confirm-write") && !dryRun) {
    fail("write requests require --confirm-write or --dry-run");
  }
  if (dryRun) {
    emit({
      dry_run: true,
      method,
      path,
      has_body: body !== undefined,
      if_match: Boolean(option(args, "--if-match")),
      idempotency_key: Boolean(option(args, "--idempotency-key")),
    });
    return;
  }

  const config = await loadConfig(option(args, "--config"));
  const headers = { accept: "application/json", authorization: `Bearer ${config.token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const etag = option(args, "--if-match");
  const idempotencyKey = option(args, "--idempotency-key");
  if (etag) headers["if-match"] = quoteEtag(etag);
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const timeout = Number(option(args, "--timeout") || 60);
  if (!Number.isFinite(timeout) || timeout <= 0) fail("--timeout must be a positive number");

  const response = await fetch(`${config.url}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeout * 1000),
  });
  const text = await response.text();
  let payload = { status: response.status };
  if (text) {
    try {
      const parsed = JSON.parse(text);
      payload = typeof parsed === "object" && !Array.isArray(parsed)
        ? { status: response.status, ...parsed }
        : { status: response.status, data: parsed };
    } catch {
      payload.error = text.slice(0, 500);
    }
  }
  emit(payload, response.ok ? process.stdout : process.stderr);
  if (!response.ok) process.exitCode = 1;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "configure") return configure(rest);
  if (command === "request") return request(rest);
  fail("command must be configure or request");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    emit({ error: error.message }, process.stderr);
    process.exitCode = 1;
  });
}
