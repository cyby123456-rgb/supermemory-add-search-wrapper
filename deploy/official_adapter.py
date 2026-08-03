#!/usr/bin/env python3
"""Expose the leaderboard Add/Search contract over Supermemory's hosted API."""

import json
import os
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PORT = int(os.environ.get("PORT", "6768"))
MEMORY_SYSTEM_KEY = os.environ.get("MEMORY_SYSTEM_KEY", "")
SUPERMEMORY_API_KEY = os.environ.get("SUPERMEMORY_API_KEY", "")
UPSTREAM_URL = os.environ.get("SUPERMEMORY_BASE_URL", "https://api.supermemory.ai").rstrip("/")
MAX_BODY_BYTES = 5 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 55
PROCESSING_TIMEOUT_SECONDS = 50


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def upstream_post(path, payload):
    request = Request(
        UPSTREAM_URL + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + SUPERMEMORY_API_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = {}
        raise RuntimeError(body.get("message") or body.get("error", {}).get("message") or "Supermemory API request failed", exc.code)
    except (URLError, TimeoutError) as exc:
        raise RuntimeError("Supermemory API is unavailable", 502) from exc


def upstream_get(path):
    request = Request(UPSTREAM_URL + path, headers={"Authorization": "Bearer " + SUPERMEMORY_API_KEY}, method="GET")
    try:
        with urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        raise RuntimeError("Supermemory document status request failed", exc.code) from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError("Supermemory API is unavailable", 502) from exc


def wait_for_document(document_id):
    deadline = time.monotonic() + PROCESSING_TIMEOUT_SECONDS
    status = "queued"
    while time.monotonic() < deadline:
        _, document = upstream_get("/v3/documents/" + document_id)
        status = document.get("status", "queued")
        if status == "done":
            return document
        if status in ("failed", "error"):
            raise RuntimeError("Supermemory document processing failed", 502)
        time.sleep(1)
    raise RuntimeError("Supermemory document processing timed out", 504)


def authorized(headers):
    value = headers.get("Authorization", "")
    return MEMORY_SYSTEM_KEY and (value in ("Bearer " + MEMORY_SYSTEM_KEY, "Token " + MEMORY_SYSTEM_KEY) or headers.get("X-Api-Key") == MEMORY_SYSTEM_KEY)


class Handler(BaseHTTPRequestHandler):
    server_version = "SupermemoryHostedAdapter/0.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key")
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, status, message, code):
        self.respond(status, {"error": {"code": code, "message": message}, "message": message})

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid Content-Length")
        if length > MAX_BODY_BYTES:
            raise OverflowError("Request body too large")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ValueError("Invalid JSON body")

    def do_OPTIONS(self):
        self.respond(204, {})

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self.respond(200, {"status": "ok", "service": "supermemory-hosted-adapter", "timestamp": now()})
        elif self.path.rstrip("/") == "/ready":
            self.respond(200, {"status": "ready"})
        else:
            self.error_json(404, "Not found", "NOT_FOUND")

    def do_POST(self):
        path = self.path.rstrip("/")
        if path not in ("/add", "/search"):
            self.error_json(404, "Not found", "NOT_FOUND")
            return
        if not authorized(self.headers):
            self.error_json(401, "Missing or invalid bearer token", "UNAUTHORIZED")
            return
        try:
            payload = self.read_json()
        except OverflowError as exc:
            self.error_json(413, str(exc), "PAYLOAD_TOO_LARGE")
            return
        except ValueError as exc:
            self.error_json(400, str(exc), "BAD_REQUEST")
            return
        if path == "/add":
            self.handle_add(payload)
        else:
            self.handle_search(payload)

    def handle_add(self, payload):
        request_id, messages = payload.get("request_id"), payload.get("messages")
        user_id, session_id = payload.get("user_id"), payload.get("session_id")
        valid_messages = isinstance(messages, list) and messages and all(
            isinstance(item, dict) and str(item.get("role", "")).strip() and str(item.get("content", "")).strip() for item in messages
        )
        if not request_id or not user_id or not session_id or not valid_messages:
            self.error_json(422, "request_id, non-empty messages, user_id, and session_id are required", "VALIDATION_ERROR")
            return
        content = "\n".join("%s: %s" % (item["role"], item["content"]) for item in messages)
        try:
            _, upstream = upstream_post("/v3/documents", {
                "content": content,
                "containerTag": user_id,
                "customId": request_id,
                "metadata": {"session_id": session_id, "request_id": request_id},
                "taskType": "memory",
            })
            if not upstream.get("id"):
                raise RuntimeError("Supermemory did not return a document ID", 502)
            wait_for_document(upstream["id"])
        except RuntimeError as exc:
            self.error_json(exc.args[1] if len(exc.args) > 1 else 502, str(exc.args[0]), "UPSTREAM_ERROR")
            return
        self.respond(200, {"success": True, "request_id": request_id, "user_id": user_id, "session_id": session_id, "upstream_id": upstream.get("id"), "upstream_status": upstream.get("status")})

    def handle_search(self, payload):
        query, user_id, top_k = payload.get("query"), payload.get("user_id"), payload.get("top_k")
        if not str(query or "").strip() or not str(user_id or "").strip() or not isinstance(top_k, int) or top_k < 0:
            self.error_json(422, "query, user_id, and non-negative integer top_k are required", "VALIDATION_ERROR")
            return
        try:
            # Hybrid mode makes completed document chunks available before background fact extraction finishes.
            _, upstream = upstream_post("/v4/search", {"q": query, "containerTag": user_id, "searchMode": "hybrid"})
        except RuntimeError as exc:
            self.error_json(exc.args[1] if len(exc.args) > 1 else 502, str(exc.args[0]), "UPSTREAM_ERROR")
            return
        data = []
        for item in upstream.get("results", []):
            content = item.get("memory") or item.get("chunk")
            if not content and item.get("chunks"):
                content = item["chunks"][0].get("content")
            if content:
                data.append({"id": item.get("id", "mem_" + uuid.uuid4().hex), "content": content, "score": item.get("similarity", 0), "created_at": item.get("updatedAt", now())})
        self.respond(200, {"data": data[:top_k]})


if __name__ == "__main__":
    if not MEMORY_SYSTEM_KEY or not SUPERMEMORY_API_KEY:
        raise SystemExit("MEMORY_SYSTEM_KEY and SUPERMEMORY_API_KEY must be set")
    print("Listening on 0.0.0.0:%d; upstream=%s" % (PORT, UPSTREAM_URL), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
