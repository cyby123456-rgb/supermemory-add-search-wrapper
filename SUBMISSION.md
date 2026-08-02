# Agent Memory Leaderboard Submission Notes

## System

- System name: `Local Supermemory-Compatible Memory`
- Version: `v0.1.0`
- Track: Textual Memory
- API entrypoint: `POST /add`, `POST /search`
- Health check: `GET /health`
- Authentication: `Authorization: Bearer <SUPERMEMORY_API_KEY>`

## Run Instructions

The service requires Node.js 24 or a Docker runtime. It has no runtime package dependencies.

```bash
SUPERMEMORY_API_KEY='replace-with-a-long-random-secret' docker compose up -d --build
```

The container exposes port `6767`. Supply the following endpoints when using the hosted API route:

```text
Add:    https://<public-host>/add
Search: https://<public-host>/search
Health: https://<public-host>/health
```

## Contract Compliance

- `POST /add` performs synchronous persistence and returns `HTTP 200` only after the supplied messages can be searched.
- The Add response exactly returns `success`, `request_id`, `user_id`, and `session_id`.
- `POST /search` scopes every query to the exact supplied `user_id` and returns a relevance-sorted top-level `data` array.
- Search results contain the required stable `id` and non-empty `content`; `score` and `created_at` are also returned.
- `GET /health` is unauthenticated and returns `HTTP 200`.
- Authentication supports `Authorization: Bearer`, `Authorization: Token`, and `X-Api-Key`.

## Method

This implementation stores conversation content immediately, derives lightweight memory facts using deterministic Chinese and English patterns, and ranks same-user memories with token-overlap relevance plus a small recency weight. Persistent state is stored in a JSON file mounted at `/data` in Docker.

## Attribution and Originality

This repository contains a standalone implementation written for this submission with Node.js standard-library APIs only. No source code from Supermemory or other memory-system repositories is included. Supermemory's public API documentation was consulted solely as a compatibility reference for the optional `/v3` and `/v4` endpoints. The Agent Memory Leaderboard Add/Search contract is implemented from the published integration guide.

## Data Handling

Evaluation data is used only to serve the current evaluation. Do not run this service with persistent evaluation data after the retention window specified by the leaderboard; remove its mounted data volume within 30 days after the evaluation.
