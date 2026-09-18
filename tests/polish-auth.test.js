const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/routes/app');
const { readConfig } = require('../src/config/runtime');
const { testAuth, testEnv, password, loginTestServer } = require('./support/session');
const Workspace = require('../public/workspace');
// FEATURE/FUNCTION: Authenticated test server. PURPOSE: Count mocked provider entry points without spending API credit.
async function serve(t, auth = testAuth) {
  let discoveryCalls = 0, commentCalls = 0;
  const app = createApp({ auth, apifyConfigured: true, openaiConfigured: true,
    discovery: { searchPosts: async () => { discoveryCalls++; return { posts: [], meta: { source: 'cache' } }; }, cacheStatus: () => ({ available: true }) },
    comments: { generate: async () => { commentCalls++; return { comments: [] }; } } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { app.locals.sessionStore.stopInterval(); server.closeAllConnections(); server.close(resolve); }));
  return { url: 'http://127.0.0.1:' + server.address().port, counts: () => ({ discoveryCalls, commentCalls }), app };
}
// FEATURE/FUNCTION: Proxy simulation. PURPOSE: Preserve the Host header that native fetch intentionally normalizes.
function proxyFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = require('node:http').request(url, { method: options.method || 'GET', headers: options.headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject); request.end(options.body);
  });
}
const headersFor = session => ({ Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' });
test('breakdown displays only supported nonzero counters and never invents a fetched count', () => {
  const text = Workspace.describeSearch({ count: 2, requested: 5, excluded: { outsideRange: 1, timestamp: 2, invalid: 0, duplicate: 1 }, agedOut: 1 });
  assert.match(text, /^2 usable posts · up to 5 candidates requested/);
  assert.match(text, /1 excluded: outside the selected time window or future-dated/);
  assert.match(text, /2 excluded: missing a reliable timestamp/);
  assert.match(text, /1 excluded: duplicate posts/); assert.match(text, /cached posts that have since left/);
  assert.ok(!text.includes('invalid content')); assert.ok(!text.includes('fetched'));
  assert.equal(Workspace.describeSearch({ count: 0, requested: 10, excluded: {}, agedOut: 0 }), '0 usable posts · up to 10 candidates requested');
});
test('legacy and expired LinkedIn references disable generation without affecting stored drafts', () => {
  const now = Date.now(), valid = { mode: 'linkedin', searchId: 'a'.repeat(64), expiresAt: new Date(now + 10000).toISOString(), drafts: ['saved draft'] };
  assert.equal(Workspace.availability(valid, now).available, true);
  for (const changed of [{ ...valid, searchId: undefined }, { ...valid, searchId: 'bad' }, { ...valid, expiresAt: new Date(now).toISOString() },
    { ...valid, expiresAt: undefined }, { ...valid, cacheUnavailable: true }]) assert.equal(Workspace.availability(changed, now).available, false);
  assert.equal(Workspace.availability({ mode: 'manual' }, now).available, true);
  assert.deepEqual(valid.drafts, ['saved draft']);
});
test('successful explicit search triggers exactly one first-comment batch when selected, never for stale results', async () => {
  let generations = 0, renders = 0; const meta = { searchId: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const ui = { acceptSearch: (_posts, receivedMeta, context) => { assert.equal(receivedMeta, meta); return context === 1; },
    renderPosts: () => { renders++; }, generateDisplayed: async () => { generations++; } };
  assert.equal(await Workspace.finishSearch({ posts: [], meta }, 1, true, ui), true);
  assert.equal(generations, 1); assert.equal(renders, 1);
  await Workspace.finishSearch({ posts: [], meta }, 1, false, ui);
  await Workspace.finishSearch({ posts: [], meta }, 2, true, ui);
  assert.equal(generations, 1); assert.equal(renders, 2);
});
test('configuration requires auth locally and online, validates HTTPS/proxy, and respects hosting port/data path', () => {
  assert.throws(() => readConfig({}), /OWNER_USERNAME/);
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /OWNER_USERNAME/);
  assert.throws(() => readConfig({ ...testEnv, SESSION_SECRET: 'weak' }), /SESSION_SECRET/);
  assert.throws(() => readConfig({ ...testEnv, NODE_ENV: 'production' }), /PUBLIC_ORIGIN/);
  assert.throws(() => readConfig({ ...testEnv, NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.throws(() => readConfig({ ...testEnv, TRUST_PROXY_HOPS: '99' }), /TRUST_PROXY/);
  assert.throws(() => readConfig({ ...testEnv, HOST: '0.0.0.0' }), /production mode/);
  const config = readConfig({ ...testEnv, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://commentflow.example', PORT: '9876', DATA_DIR: './persistent-test', TRUST_PROXY_HOPS: '1' });
  assert.equal(config.port, 9876); assert.equal(config.host, '0.0.0.0'); assert.ok(config.cacheFile.includes('persistent-test'));
  assert.equal(readConfig({ ...testEnv, PORT: '3002' }).port, 3002);
});
test('anonymous users cannot access the dashboard or invoke private providers', async t => {
  const f = await serve(t);
  assert.equal((await fetch(f.url + '/', { redirect: 'manual' })).status, 303);
  for (const url of ['/api/posts/search', '/api/comments/generate']) {
    const response = await fetch(f.url + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
  }
  for (const url of ['/api/config', '/api/posts/cache/' + 'a'.repeat(64)]) assert.equal((await fetch(f.url + url)).status, 401);
  assert.deepEqual(await (await fetch(f.url + '/api/health')).json(), { status: 'ok' });
  assert.equal((await fetch(f.url + '/login')).status, 200); assert.deepEqual(f.counts(), { discoveryCalls: 0, commentCalls: 0 });
});
test('login rotates session, authenticated workflow works, CSRF blocks mutations, and logout invalidates old cookies', async t => {
  const f = await serve(t);
  const before = await fetch(f.url + '/api/auth/session'), oldCookie = before.headers.get('set-cookie').split(';')[0];
  const session = await loginTestServer(f.url);
  assert.notEqual(session.cookie, oldCookie);
  assert.equal((await fetch(f.url + '/api/config', { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await fetch(f.url + '/', { headers: { Cookie: session.cookie } })).status, 200);
  assert.deepEqual(await (await fetch(f.url + '/api/config', { headers: { Cookie: session.cookie } })).json(), { apifyConfigured: true, openaiConfigured: true });
  assert.equal((await fetch(f.url + '/api/posts/search', { method: 'POST', headers: headersFor(session), body: '{}' })).status, 200);
  assert.equal((await fetch(f.url + '/api/comments/generate', { method: 'POST', headers: headersFor(session), body: '{}' })).status, 200);
  assert.equal((await fetch(f.url + '/api/comments/generate', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.url + '/api/posts/search', { method: 'POST', headers: { ...headersFor(session), Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.url + '/api/auth/logout', { method: 'POST', headers: headersFor(session), body: '{}' })).status, 200);
  assert.equal((await fetch(f.url + '/api/comments/generate', { method: 'POST', headers: headersFor(session), body: '{}' })).status, 401);
  assert.deepEqual(f.counts(), { discoveryCalls: 1, commentCalls: 1 });
});
test('session cookie is HttpOnly, SameSite Strict, expiring and Secure behind the configured HTTPS proxy', async t => {
  const auth = readConfig({ ...testEnv, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://commentflow.example', TRUST_PROXY_HOPS: '1' });
  const f = await serve(t, auth), headers = { Host: 'commentflow.example', 'X-Forwarded-Proto': 'https' };
  const bootstrap = await proxyFetch(f.url + '/api/auth/session', { headers });
  assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
  const cookie = bootstrap.headers.get('set-cookie');
  assert.match(cookie, /^__Host-commentflow.sid=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Expires=/);
  const session = await bootstrap.json();
  const login = await proxyFetch(f.url + '/api/auth/login', { method: 'POST', headers: { ...headers, Cookie: cookie.split(';')[0], 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json', Origin: 'https://commentflow.example' },
    body: JSON.stringify({ username: testAuth.username, password }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /Secure/);
  const notTrusted = await serve(t, { ...auth, proxyHops: 0 });
  assert.equal((await proxyFetch(notTrusted.url + '/api/auth/session', { headers })).status, 403);
});
test('login attempts and paid endpoints are rate limited before provider calls', async t => {
  const f = await serve(t);
  const session = await loginTestServer(f.url);
  for (let index = 0; index < 12; index++) assert.equal((await fetch(f.url + '/api/comments/generate', { method: 'POST', headers: headersFor(session), body: '{}' })).status, 200);
  assert.equal((await fetch(f.url + '/api/comments/generate', { method: 'POST', headers: headersFor(session), body: '{}' })).status, 429);
  assert.equal(f.counts().commentCalls, 12);
  const other = await serve(t);
  const response = await fetch(other.url + '/api/auth/session');
  const token = (await response.json()).csrfToken, cookie = response.headers.get('set-cookie').split(';')[0];
  for (let index = 0; index < 5; index++) assert.equal((await fetch(other.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token },
    body: JSON.stringify({ username: testAuth.username, password: 'wrong-password' }) })).status, 401);
  assert.equal((await fetch(other.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token }, body: '{}' })).status, 429);
  assert.deepEqual(other.counts(), { discoveryCalls: 0, commentCalls: 0 });
});
