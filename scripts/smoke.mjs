const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:6767';
const apiKey = process.env.SUPERMEMORY_API_KEY || 'sm_local_dev_key';

async function call(path, method = 'GET', body) {
  const response = await fetch(baseUrl + path, { method, headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(payload));
  return payload;
}

const health = await call('/health');
const userId = 'smoke_' + Date.now();
const added = await call('/add', 'POST', { request_id: userId + '_request', user_id: userId, session_id: userId + '_session', messages: [{ role: 'user', content: 'I prefer concise Chinese answers and I live in Shanghai.' }] });
const results = await call('/search', 'POST', { query: 'Where does the user live?', user_id: userId, top_k: 100 });
if (!results.data.length) throw new Error('Expected a matching memory');
console.log(JSON.stringify({ health, add: added, topResult: results.data[0] }, null, 2));
