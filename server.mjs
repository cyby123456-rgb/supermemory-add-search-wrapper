import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const port = Number(process.env.PORT || process.env.SUPERMEMORY_PORT || 6767);
const dataFile = resolve(process.env.SUPERMEMORY_DATA_FILE || ".data/store.json");
const apiKey = process.env.SUPERMEMORY_API_KEY || "sm_local_dev_key";
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 5 * 1024 * 1024);

const initialStore = () => ({
  documents: [], memories: [], containers: {}, settings: { profileBuckets: [] }, jobs: [],
});

function loadStore() {
  if (!existsSync(dataFile)) return initialStore();
  try {
    const parsed = JSON.parse(readFileSync(dataFile, "utf8"));
    return { ...initialStore(), ...parsed };
  } catch {
    return initialStore();
  }
}

let store = loadStore();

function persist() {
  mkdirSync(dirname(dataFile), { recursive: true });
  const temporary = `${dataFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2));
  renameSync(temporary, dataFile);
}

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function lower(value) { return String(value || "").toLocaleLowerCase(); }
function activeMemory(memory) { return !memory.forgottenAt && memory.isLatest !== false; }

function tokenize(value) {
  const words = lower(value).match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = (String(value || "").match(/[\u3400-\u9fff]/g) || []);
  return new Set([...words, ...cjk]);
}

function score(query, content, updatedAt) {
  const a = tokenize(query); const b = tokenize(content);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const term of a) if (b.has(term)) overlap += 1;
  const lexical = overlap / Math.sqrt(a.size * b.size);
  const ageDays = Math.max(0, (Date.now() - Date.parse(updatedAt || now())) / 86400000);
  return Number((lexical * 0.92 + Math.max(0, 1 - ageDays / 365) * 0.08).toFixed(4));
}

function chunk(content) {
  const text = String(content || "").trim();
  if (!text) return [];
  const pieces = text.split(/(?<=[.!?。！？\n])\s*/u).filter(Boolean);
  const chunks = []; let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > 700) { chunks.push(current.trim()); current = ""; }
    current += `${piece} `;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, 700)];
}

function ensureContainer(tag) {
  const containerTag = String(tag || "default");
  if (!store.containers[containerTag]) {
    store.containers[containerTag] = { containerTag, createdAt: now(), updatedAt: now(), settings: {} };
  }
  return containerTag;
}

function normalizeDocument(document) {
  return {
    id: document.id, customId: document.customId || null, containerTag: document.containerTag,
    content: document.content, metadata: document.metadata || {}, status: document.status,
    createdAt: document.createdAt, updatedAt: document.updatedAt,
  };
}

function extractFacts(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const patterns = [
    [/\bI (?:like|love|prefer)\s+([^.!?。！？]+)/i, "preference"],
    [/\bI(?:'m| am)\s+([^.!?。！？]+)/i, "identity"],
    [/\bI live in\s+([^.!?。！？]+)/i, "location"],
    [/我(?:很)?喜欢([^。！？，,.!?]+)/u, "preference"],
    [/我住在([^。！？，,.!?]+)/u, "location"],
    [/我是([^。！？，,.!?]+)/u, "identity"],
  ];
  const facts = [];
  for (const [pattern, type] of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) facts.push({ content: `User ${type}: ${match[1].trim()}`, type, isDynamic: false });
  }
  return facts.length ? facts : [{ content: text.slice(0, 500), type: "context", isDynamic: true }];
}

function upsertMemory({ content, containerTag, sourceDocumentId = null, metadata = {}, type = "fact", isDynamic = false }) {
  const same = store.memories.find((memory) => activeMemory(memory) && memory.containerTag === containerTag && lower(memory.content) === lower(content));
  if (same) return same;
  const timestamp = now();
  const memory = {
    id: id("mem"), containerTag, content, type, isDynamic, metadata, sourceDocumentId,
    confidence: 0.8, version: 1, isLatest: true, forgottenAt: null,
    createdAt: timestamp, updatedAt: timestamp,
    history: [{ version: 1, content, updatedAt: timestamp, reason: "created" }],
  };
  store.memories.push(memory);
  return memory;
}

function ingestDocument(input) {
  const content = typeof input.content === "string" ? input.content : input.content?.text || input.text || "";
  if (!String(content).trim()) throw Object.assign(new Error("content is required"), { statusCode: 422 });
  const containerTag = ensureContainer(input.containerTag);
  const timestamp = now();
  const customId = input.customId || null;
  let document = customId && store.documents.find((item) => item.containerTag === containerTag && item.customId === customId);
  if (document) {
    document.content = content; document.metadata = input.metadata || document.metadata || {};
    document.updatedAt = timestamp; document.status = "completed"; document.chunks = chunk(content);
  } else {
    document = {
      id: id("doc"), customId, containerTag, content, metadata: input.metadata || {},
      status: "completed", createdAt: timestamp, updatedAt: timestamp, chunks: chunk(content), contentHash: hash(content),
    };
    store.documents.push(document);
  }
  for (const fact of extractFacts(content)) {
    upsertMemory({ ...fact, containerTag, sourceDocumentId: document.id, metadata: input.metadata || {} });
  }
  persist();
  return document;
}

function findDocument(value) { return store.documents.find((document) => document.id === value || document.customId === value); }
function findMemory(value) { return store.memories.find((memory) => memory.id === value); }

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" });
  response.end(JSON.stringify(value));
}

function error(response, status, message, code = "BAD_REQUEST") {
  json(response, status, { error: { code, message }, message });
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const buffers = []; let size = 0;
    request.on("data", (part) => { size += part.length; if (size > maxBodyBytes) reject(Object.assign(new Error("Request body too large"), { statusCode: 413 })); else buffers.push(part); });
    request.on("end", () => {
      if (!buffers.length) return resolveBody({});
      try { resolveBody(JSON.parse(Buffer.concat(buffers).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 })); }
    });
    request.on("error", reject);
  });
}

function checkAuth(request) {
  const header = request.headers.authorization || "";
  return header === `Bearer ${apiKey}` || header === `Token ${apiKey}` || request.headers["x-api-key"] === apiKey;
}

function openapi() {
  return {
    openapi: "3.1.0", info: { title: "Supermemory-compatible API", version: "0.1.0", description: "Local compatible implementation of core Supermemory API operations." },
    servers: [{ url: "/" }], security: [{ bearerAuth: [] }], components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/add": { post: { summary: "Agent Memory Leaderboard synchronous Add endpoint" } },
      "/search": { post: { summary: "Agent Memory Leaderboard Search endpoint" } },
      "/v3/documents": { post: { summary: "Add document" } }, "/v3/search": { post: { summary: "Search documents" } },
      "/v4/conversations": { post: { summary: "Ingest or update conversation" } }, "/v4/memories": { post: { summary: "Create memory" }, patch: { summary: "Update memory" }, delete: { summary: "Forget memory" } },
      "/v4/search": { post: { summary: "Search memories" } }, "/v4/profile": { post: { summary: "Get profile" } },
    },
  };
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = request.method || "GET";
  if (method === "OPTIONS") return json(response, 204, {});
  if (path === "/health") return json(response, 200, { status: "ok", service: "supermemory-compatible-api", timestamp: now() });
  if (path === "/ready") return json(response, 200, { status: "ready" });
  if (path === "/openapi.json") return json(response, 200, openapi());
  if (!checkAuth(request)) return error(response, 401, "Missing or invalid bearer token", "UNAUTHORIZED");
  const body = ["POST", "PATCH", "DELETE"].includes(method) ? await readBody(request) : {};

  // This adapter follows the Agent Memory Leaderboard's exact synchronous contract.
  if (method === "POST" && path === "/add") {
    const { request_id: requestId, messages, user_id: userId, session_id: sessionId } = body;
    if (!requestId || !userId || !sessionId || !Array.isArray(messages) || !messages.length || messages.some((message) => !message || !String(message.content || "").trim() || !String(message.role || "").trim())) {
      return error(response, 422, "request_id, non-empty messages, user_id, and session_id are required", "VALIDATION_ERROR");
    }
    const content = messages.map((message) => `${message.role}: ${message.content}`).join("\n");
    const document = ingestDocument({ content, containerTag: userId, customId: requestId, metadata: { session_id: sessionId, request_id: requestId } });
    for (const message of messages) {
      upsertMemory({ content: String(message.content), containerTag: userId, sourceDocumentId: document.id, metadata: { session_id: sessionId, request_id: requestId, role: message.role, timestamp: message.timestamp || null }, type: "conversation", isDynamic: true });
    }
    persist();
    return json(response, 200, { success: true, request_id: requestId, user_id: userId, session_id: sessionId });
  }

  if (method === "POST" && path === "/search") {
    const { query, user_id: userId, top_k: topK } = body;
    if (!String(query || "").trim() || !String(userId || "").trim() || !Number.isInteger(topK) || topK < 0) {
      return error(response, 422, "query, user_id, and non-negative integer top_k are required", "VALIDATION_ERROR");
    }
    const data = store.memories.filter((memory) => activeMemory(memory) && memory.containerTag === userId)
      .map((memory) => ({ id: memory.id, content: memory.content, score: score(query, memory.content, memory.updatedAt), created_at: memory.createdAt }))
      .filter((memory) => memory.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
    return json(response, 200, { data });
  }

  if (method === "POST" && path === "/v3/documents") return json(response, 201, { document: normalizeDocument(ingestDocument(body)) });
  if (method === "POST" && path === "/v3/documents/batch") {
    const documents = body.documents || body.items || [];
    if (!Array.isArray(documents)) return error(response, 422, "documents must be an array", "VALIDATION_ERROR");
    return json(response, 201, { documents: documents.map(ingestDocument).map(normalizeDocument) });
  }
  if (method === "POST" && path === "/v3/documents/list") {
    const tags = asArray(body.containerTag || body.containerTags); const limit = Math.min(Number(body.limit || 20), 100); const offset = Number(body.offset || 0);
    const documents = store.documents.filter((item) => !tags.length || tags.includes(item.containerTag)).slice(offset, offset + limit).map(normalizeDocument);
    return json(response, 200, { documents, total: documents.length, offset, limit });
  }
  if (method === "GET" && path === "/v3/documents/processing") return json(response, 200, { documents: store.documents.filter((item) => item.status !== "completed") });
  if (method === "POST" && path === "/v3/search") {
    const q = body.q || body.query || ""; const tags = asArray(body.containerTag || body.containerTags); const limit = Math.min(Number(body.limit || 10), 100);
    const results = store.documents.filter((item) => !tags.length || tags.includes(item.containerTag)).flatMap((document) => document.chunks.map((content, index) => ({ documentId: document.id, chunkId: `${document.id}_${index}`, content, metadata: document.metadata, containerTag: document.containerTag, score: score(q, content, document.updatedAt) }))).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    return json(response, 200, { results, searchResults: results });
  }
  if (method === "DELETE" && path === "/v3/documents/bulk") {
    const ids = new Set(body.ids || body.documentIds || []); const tags = new Set(asArray(body.containerTag || body.containerTags)); const before = store.documents.length;
    store.documents = store.documents.filter((item) => !(ids.has(item.id) || (tags.size && tags.has(item.containerTag)))); persist();
    return json(response, 200, { success: true, deleted: before - store.documents.length });
  }
  const documentMatch = path.match(/^\/v3\/documents\/([^/]+)(\/chunks)?$/);
  if (documentMatch) {
    const document = findDocument(decodeURIComponent(documentMatch[1]));
    if (!document) return error(response, 404, "Document not found", "NOT_FOUND");
    if (documentMatch[2] && method === "GET") return json(response, 200, { chunks: document.chunks.map((content, position) => ({ id: `${document.id}_${position}`, content, position })) });
    if (method === "GET") return json(response, 200, { document: normalizeDocument(document) });
    if (method === "PATCH") { if (body.content) { document.content = body.content; document.chunks = chunk(body.content); } document.metadata = { ...document.metadata, ...(body.metadata || {}) }; document.updatedAt = now(); persist(); return json(response, 200, { document: normalizeDocument(document) }); }
    if (method === "DELETE") { store.documents = store.documents.filter((item) => item.id !== document.id); persist(); return json(response, 200, { success: true, id: document.id }); }
  }
  if (method === "POST" && path === "/v4/conversations") {
    const messages = body.messages || body.conversation || [];
    const content = typeof body.content === "string" ? body.content : Array.isArray(messages) ? messages.map((message) => `${message.role || "user"}: ${message.content || ""}`).join("\n") : "";
    const document = ingestDocument({ ...body, content, customId: body.customId || body.id || body.conversationId });
    return json(response, 201, { id: document.id, document: normalizeDocument(document), status: document.status });
  }
  if (method === "POST" && path === "/v4/memories") {
    if (!body.content) return error(response, 422, "content is required", "VALIDATION_ERROR");
    const containerTag = ensureContainer(body.containerTag); const memory = upsertMemory({ content: body.content, containerTag, metadata: body.metadata || {}, type: body.type || "fact", isDynamic: Boolean(body.isDynamic) }); persist();
    return json(response, 201, { memory });
  }
  if (method === "PATCH" && path === "/v4/memories") {
    const memory = findMemory(body.id || body.memoryId); if (!memory) return error(response, 404, "Memory not found", "NOT_FOUND");
    if (body.content && body.content !== memory.content) { memory.history.push({ version: memory.version, content: memory.content, updatedAt: memory.updatedAt, reason: "superseded" }); memory.content = body.content; memory.version += 1; }
    memory.metadata = { ...memory.metadata, ...(body.metadata || {}) }; memory.updatedAt = now(); memory.history.push({ version: memory.version, content: memory.content, updatedAt: memory.updatedAt, reason: "updated" }); persist(); return json(response, 200, { memory });
  }
  if (method === "DELETE" && path === "/v4/memories") {
    const memory = findMemory(body.id || body.memoryId || url.searchParams.get("id")); if (!memory) return error(response, 404, "Memory not found", "NOT_FOUND"); memory.forgottenAt = now(); memory.isLatest = false; memory.updatedAt = now(); persist(); return json(response, 200, { success: true, id: memory.id });
  }
  if (method === "POST" && path === "/v4/memories/list") {
    const tags = asArray(body.containerTag || body.containerTags); const memories = store.memories.filter((item) => (!tags.length || tags.includes(item.containerTag)) && (body.includeForgotten || activeMemory(item))).slice(0, Math.min(Number(body.limit || 50), 200)); return json(response, 200, { memories, total: memories.length });
  }
  if (method === "POST" && path === "/v4/memories/forget-matching") {
    const q = body.q || body.query || body.prompt || ""; const tags = asArray(body.containerTag || body.containerTags); const matches = store.memories.filter((item) => activeMemory(item) && (!tags.length || tags.includes(item.containerTag)) && score(q, item.content, item.updatedAt) > 0);
    if (body.dryRun) return json(response, 200, { dryRun: true, memories: matches });
    for (const memory of matches) { memory.forgottenAt = now(); memory.isLatest = false; }
    persist(); return json(response, 200, { success: true, forgotten: matches.length });
  }
  if (method === "POST" && path === "/v4/search") {
    const q = body.q || body.query || ""; const tags = asArray(body.containerTag || body.containerTags); const limit = Math.min(Number(body.limit || 10), 100);
    const results = store.memories.filter((item) => activeMemory(item) && (!tags.length || tags.includes(item.containerTag))).map((memory) => ({ ...memory, score: score(q, memory.content, memory.updatedAt) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    return json(response, 200, { results, memories: results });
  }
  if (method === "POST" && path === "/v4/profile") {
    const containerTag = ensureContainer(body.containerTag); const memories = store.memories.filter((item) => activeMemory(item) && item.containerTag === containerTag); const staticFacts = memories.filter((item) => !item.isDynamic).map((item) => item.content); const dynamicFacts = memories.filter((item) => item.isDynamic).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => item.content).slice(0, 20);
    const q = body.q || body.query || ""; const searchResults = memories.map((item) => ({ ...item, score: score(q, item.content, item.updatedAt) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Number(body.limit || 10));
    return json(response, 200, { profile: { static: staticFacts, dynamic: dynamicFacts }, searchResults });
  }
  if (method === "POST" && path === "/v4/profile/buckets") return json(response, 200, { buckets: store.settings.profileBuckets || [] });
  if (path === "/v3/settings") { if (method === "GET") return json(response, 200, store.settings); if (method === "PATCH") { store.settings = { ...store.settings, ...body }; persist(); return json(response, 200, store.settings); } }
  const containerMatch = path.match(/^\/v3\/container-tags\/([^/]+)$/);
  if (containerMatch) {
    const tag = decodeURIComponent(containerMatch[1]);
    if (method === "GET") { const item = store.containers[tag]; return item ? json(response, 200, item) : error(response, 404, "Container tag not found", "NOT_FOUND"); }
    if (method === "PATCH") { const item = store.containers[tag] || { containerTag: tag, createdAt: now(), settings: {} }; item.settings = { ...item.settings, ...body }; item.updatedAt = now(); store.containers[tag] = item; persist(); return json(response, 200, item); }
    if (method === "DELETE") { delete store.containers[tag]; store.documents = store.documents.filter((item) => item.containerTag !== tag); store.memories = store.memories.filter((item) => item.containerTag !== tag); persist(); return json(response, 200, { success: true, containerTag: tag }); }
  }
  if (path.startsWith("/v3/") || path.startsWith("/v4/")) {
    return error(response, 501, `The compatible implementation does not yet support ${method} ${path}`, "NOT_IMPLEMENTED");
  }
  return error(response, 404, `No compatible route for ${method} ${path}`, "NOT_FOUND");
}

const server = createServer((request, response) => route(request, response).catch((cause) => error(response, cause.statusCode || 500, cause.message || "Internal server error", cause.statusCode ? "REQUEST_ERROR" : "INTERNAL_ERROR")));
server.listen(port, () => console.log(`Supermemory-compatible API listening on http://0.0.0.0:${port}`));
