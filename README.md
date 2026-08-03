# Supermemory Hosted Add/Search Adapter

面向 Agent Memory Leaderboard 的同步 Add/Search 适配层。它不重写 Supermemory 的记忆引擎：每次写入和检索都调用 [Supermemory 官方云 API](https://supermemory.ai/docs)，并将官方协议转换为评测要求的 `POST /add` 与 `POST /search` 协议。

## 工作方式

```text
Leaderboard -> this adapter (/add, /search) -> Supermemory hosted API
```

- `/add` 将 `messages` 拼为会话文本，映射为官方 `POST /v3/documents`。
- 写入后适配层轮询文档状态，仅当官方状态为 `done` 时返回成功，避免下一个 Search 读到尚未处理的数据。
- `/search` 调用官方 `POST /v4/search` 的 `hybrid` 模式；该模式可在后台事实抽取完成前检索已处理的文档块。
- `user_id` 映射为官方 `containerTag`，`request_id` 映射为 `customId`，`session_id` 存入 metadata。

## 运行

需要 Python 3.9+、一个 Supermemory 官方 API Key 和一个用于评测调用本服务的独立 Key。

```bash
cp .env.example .env
# 填写 .env 中的 MEMORY_SYSTEM_KEY 与 SUPERMEMORY_API_KEY
set -a && . ./.env && set +a
python3 deploy/official_adapter.py
```

默认地址为 `http://127.0.0.1:6768`。`GET /health` 无需认证；`/add` 与 `/search` 支持 `Authorization: Bearer`、`Authorization: Token` 和 `X-Api-Key`。

### Docker

```bash
docker compose up -d --build
```

## Leaderboard 示例

```bash
curl http://127.0.0.1:6768/add \
  -H 'Authorization: Bearer <MEMORY_SYSTEM_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"eval:demo:chunk-1","messages":[{"role":"user","content":"My favorite editor is Vim."}],"user_id":"eval:demo:user-1","session_id":"eval:demo:session-1"}'

curl http://127.0.0.1:6768/search \
  -H 'Authorization: Bearer <MEMORY_SYSTEM_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is the favorite editor?","user_id":"eval:demo:user-1","top_k":100}'
```

`/add` 只在官方文档完成处理后才返回 `HTTP 200`，并回显 `request_id`、`user_id` 和 `session_id`。`/search` 始终返回顶层 `data` 数组，结果数不超过 `top_k`。

## 重要限制

- 官方文档处理是异步的；适配层最长等待 50 秒，超时返回 `504`，上游错误返回 `502`，不会伪造成功。
- 所有评测内容都会发送到 Supermemory 官方云 API，并消耗该账号的用量额度。
- 本仓库不是 Supermemory 官方代码的 Fork，也不声称复刻其专有云模型；它只使用官方公开 SDK/API 的协议实现适配层。
