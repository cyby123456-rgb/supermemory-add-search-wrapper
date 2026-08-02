# Supermemory Add/Search Wrapper

A dependency-free Node.js memory service for the synchronous Add/Search contract required by Agent Memory Leaderboard.

## Leaderboard endpoints

- POST /add stores ordered conversation messages synchronously and returns success, request_id, user_id, and session_id.
- POST /search searches only within the exact user_id and returns a relevance-sorted top-level data array capped by top_k.
- GET /health is unauthenticated and returns HTTP 200.

Authentication supports Authorization: Bearer, Authorization: Token, and X-Api-Key.

## Run

Requires Node.js 24 with no package installation. Start the service with:

    SUPERMEMORY_API_KEY='replace-with-a-long-random-secret' node server.mjs

The default port is 6767. State persists to .data/store.json; set SUPERMEMORY_DATA_FILE to change it.

## Docker

    SUPERMEMORY_API_KEY='replace-with-a-long-random-secret' docker compose up -d --build

## Verification

Run node --test test/api.test.mjs locally. The test suite covers Add/Search compliance, persistence, user isolation, versioning, and soft forgetting.

See SUBMISSION.md for evaluation-facing deployment, contract, attribution, and data-handling notes.
