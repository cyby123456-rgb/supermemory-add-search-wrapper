import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const port = 16767;
const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), SUPERMEMORY_API_KEY: 'test-key', SUPERMEMORY_DATA_FILE: '/tmp/supermemory-test-store.json' } });
await new Promise((resolve) => child.stdout.once('data', resolve));
test.after(() => child.kill());

async function request(path, body) {
  const response = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('implements synchronous Add/Search', async () => {
  const add = await request('/add', { request_id: 'test-1', user_id: 'user-1', session_id: 'session-1', messages: [{ role: 'user', content: 'My favorite editor is Vim.' }] });
  assert.deepEqual(add.body, { success: true, request_id: 'test-1', user_id: 'user-1', session_id: 'session-1' });
  const search = await request('/search', { query: 'favorite editor', user_id: 'user-1', top_k: 100 });
  assert.equal(search.status, 200);
  assert.ok(search.body.data.length > 0);
  assert.equal(search.body.data[0].content, 'My favorite editor is Vim.');
});
