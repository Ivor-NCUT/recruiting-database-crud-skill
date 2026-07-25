#!/usr/bin/env python3
"""Authenticated, JSON-only client for recruiting workbench business APIs."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ALLOWED_METHODS = {"GET", "POST", "PATCH", "DELETE"}
DENIED_PREFIXES = (
    "/api/auth/",
    "/api/candidate-ingest/",
    "/api/connector/",
    "/api/public/",
)
CONFIG_NAME = "recruiting-database-crud.json"


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "configure":
        return configure(args)
    if args.command == "request":
        return perform_request(args)
    raise ValueError("unknown command")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    configure_parser = commands.add_parser("configure", help="store URL and token in a private Codex config")
    configure_parser.add_argument("--url", required=True)
    configure_parser.add_argument("--token-stdin", action="store_true", required=True)
    configure_parser.add_argument("--config")

    request_parser = commands.add_parser("request", help="call one private workbench business API")
    request_parser.add_argument("method", choices=sorted(ALLOWED_METHODS))
    request_parser.add_argument("path")
    payload = request_parser.add_mutually_exclusive_group()
    payload.add_argument("--data")
    payload.add_argument("--file")
    request_parser.add_argument("--if-match")
    request_parser.add_argument("--idempotency-key")
    request_parser.add_argument("--confirm-write", action="store_true")
    request_parser.add_argument("--dry-run", action="store_true")
    request_parser.add_argument("--config")
    request_parser.add_argument("--timeout", type=float, default=60)
    return root


def configure(args: argparse.Namespace) -> int:
    url = normalize_url(args.url)
    token = sys.stdin.read().strip()
    if len(token) < 32:
        fail("database token must contain at least 32 characters")
    path = config_path(args.config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"url": url, "token": token}, ensure_ascii=False) + "\n", encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    emit({"configured": True, "url": url, "config": str(path)})
    return 0


def perform_request(args: argparse.Namespace) -> int:
    method = args.method.upper()
    path = normalize_path(args.path)
    body = request_body(args)
    if method == "GET" and body is not None:
        fail("GET requests cannot include a JSON body")
    if method != "GET" and not args.confirm_write and not args.dry_run:
        fail("write requests require --confirm-write or --dry-run")

    if args.dry_run:
        emit({
            "dry_run": True,
            "method": method,
            "path": path,
            "has_body": body is not None,
            "if_match": bool(args.if_match),
            "idempotency_key": bool(args.idempotency_key),
        })
        return 0

    config = load_config(args.config)
    headers = {
        "accept": "application/json",
        "authorization": f"Bearer {config['token']}",
    }
    if body is not None:
        headers["content-type"] = "application/json"
    if args.if_match:
        headers["if-match"] = quote_etag(args.if_match)
    if args.idempotency_key:
        headers["idempotency-key"] = args.idempotency_key

    request = Request(config["url"] + path, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=args.timeout) as response:
            payload = parse_response(response.read(), response.status)
            emit(payload)
            return 0
    except HTTPError as error:
        payload = parse_response(error.read(), error.code)
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1
    except URLError as error:
        print(json.dumps({"status": 0, "error": str(error.reason)}, ensure_ascii=False), file=sys.stderr)
        return 1


def request_body(args: argparse.Namespace) -> bytes | None:
    if args.data is None and args.file is None:
        return None
    source = args.data if args.data is not None else Path(args.file).read_text(encoding="utf-8")
    try:
        payload = json.loads(source)
    except json.JSONDecodeError as error:
        fail(f"invalid JSON body: {error.msg}")
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()


def load_config(explicit: str | None) -> dict[str, str]:
    url = os.environ.get("WORKBENCH_URL", "").strip()
    token = os.environ.get("WORKBENCH_DATABASE_API_TOKEN", "").strip()
    if url and token:
        return {"url": normalize_url(url), "token": token}
    path = config_path(explicit)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read private config {path}: {error}")
    stored_url = str(payload.get("url", "")).strip()
    stored_token = str(payload.get("token", "")).strip()
    if not stored_url or not stored_token:
        fail(f"private config {path} must contain url and token")
    return {"url": normalize_url(stored_url), "token": stored_token}


def config_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    configured = os.environ.get("RECRUITING_DATABASE_CONFIG", "").strip()
    if configured:
        return Path(configured).expanduser()
    codex_home = Path(os.environ.get("CODEX_HOME", "") or Path.home() / ".codex")
    return codex_home / "private" / CONFIG_NAME


def normalize_url(value: str) -> str:
    parsed = urlsplit(str(value).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}:
        fail("workbench URL must be an http(s) origin without a path")
    return f"{parsed.scheme}://{parsed.netloc}"


def normalize_path(value: str) -> str:
    raw = str(value).strip()
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        fail("request path must be a relative API path")
    if parsed.path != "/healthz" and not parsed.path.startswith("/api/"):
        fail("request path must start with /api/ or equal /healthz")
    if any(parsed.path.startswith(prefix) for prefix in DENIED_PREFIXES):
        fail("this service identity cannot call the requested endpoint family")
    if ".." in Path(parsed.path).parts:
        fail("request path cannot contain parent traversal")
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def quote_etag(value: str) -> str:
    cleaned = str(value).strip().strip('"')
    if not cleaned or '"' in cleaned or "\n" in cleaned or "\r" in cleaned:
        fail("invalid If-Match value")
    return f'"{cleaned}"'


def parse_response(raw: bytes, status_code: int) -> dict:
    if not raw:
        return {"status": status_code}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"status": status_code, "error": raw.decode("utf-8", "replace")[:500]}
    if isinstance(payload, dict):
        return {"status": status_code, **payload}
    return {"status": status_code, "data": payload}


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def fail(message: str) -> None:
    raise SystemExit(message)


if __name__ == "__main__":
    raise SystemExit(main())
