# Agent Memory Leaderboard Submission Notes

## System

- System name: `Supermemory Hosted Add/Search Adapter`
- Version: `v0.2.0`
- Track: Textual Memory
- API entrypoint: `POST /add`, `POST /search`
- Health check: `GET /health`
- Authentication: `Authorization: Bearer <MEMORY_SYSTEM_KEY>`

## Run Instructions

The service requires Python 3.9+ or a Docker runtime, plus a valid Supermemory cloud API key.

```bash
MEMORY_SYSTEM_KEY='replace-with-a-long-random-secret' \
SUPERMEMORY_API_KEY='sm_replace_me' docker compose up -d --build
```

The container exposes port `6768`. Supply the following endpoints when using the hosted API route:

```text
Add:    http://<public-host>:6768/add
Search: http://<public-host>:6768/search
Health: http://<public-host>:6768/health
```

## Contract Compliance

- `POST /add` calls Supermemory's official `POST /v3/documents`, waits for processing status `done`, then returns `HTTP 200`.
- The Add response returns `success`, `request_id`, `user_id`, and `session_id`; upstream document information is included for diagnostics.
- `POST /search` scopes every query to the exact supplied `user_id` and returns a relevance-sorted top-level `data` array.
- Search results contain the required stable `id` and non-empty `content`; `score` and `created_at` are also returned.
- `GET /health` is unauthenticated and returns `HTTP 200`.
- Authentication supports `Authorization: Bearer`, `Authorization: Token`, and `X-Api-Key`.

## Method

This adapter concatenates leaderboard messages, uses `user_id` as Supermemory's `containerTag`, uses `request_id` as `customId`, and stores `session_id` in metadata. Search calls Supermemory's official `POST /v4/search` in `hybrid` mode and maps its result fields into the leaderboard response. A single Add may take up to 50 seconds because the official document pipeline is asynchronous.

## Attribution and Originality

This repository contains an independent adapter implemented with Python's standard library. It uses Supermemory's public hosted API and does not contain Supermemory source code or claim to reproduce its proprietary cloud models. The Agent Memory Leaderboard Add/Search contract is implemented from the published integration guide.

## Data Handling

Evaluation data is transmitted to Supermemory's hosted API and is subject to its service terms and the account's data-handling settings. Do not run this service after the leaderboard retention window unless that data handling is authorized.
