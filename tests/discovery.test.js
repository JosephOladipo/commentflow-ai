const test = require('node:test');
const { testAuth, loginTestServer, authenticatedFetch: fetch } = require('./support/session');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateSearch, cacheKey, linkedinUrl, timestamp, normalizePosts, AppError } = require('../src/utils/posts');
const { createProvider } = require('../src/services/apify');
const { createDiscovery, TTL } = require('../src/services/discovery');
const { createApp } = require('../src/routes/app');
const NOW = Date.parse('2026-09-12T12:00:00Z');
const query = { platform: 'linkedin', keywords: 'AI automation', timeRange: '3d', limit: 5, sortBy: 'newest' };
// FEATURE/FUNCTION: Synthetic test fixtures. PURPOSE: Verify behavior offline; these are never served as real opportunities.
function fixture(id = '1234567890123456789', age = 3600000) {
  return { url: 'https://www.linkedin.com/posts/test_topic-activity-' + id + '-AbCd', text: 'Synthetic unit test about AI automation.',
    posted_at: { timestamp: NOW - age }, author: { first_name: 'Test', last_name: 'Author', headline: 'Fixture only' },
    stats: { total_reactions: 0, comments: 3 } };
}
async function tempCache(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commentflow-test-'));
  t.after(async () => {
    const target = path.resolve(dir), root = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(root) || !path.basename(target).startsWith('commentflow-test-')) throw new Error('Unsafe cleanup path');
    await fs.rm(target, { recursive: true, force: true });
  });
  return path.join(dir, 'cache.json');
}
async function serve(t, options) {
  const app = createApp({ ...options, auth: testAuth });
  t.after(() => app.locals.sessionStore.stopInterval());
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  await loginTestServer(url); return url;
}
function post(url, body, extra = {}) {
  return fetch(url + '/api/posts/search', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
}
test('validation rejects unsupported, excessive, empty and malformed input', () => {
  for (const invalid of [null, [], {}, { ...query, platform: 'x' }, { ...query, timeRange: '__proto__' }, { ...query, timeRange: '30d' },
    { ...query, limit: 50 }, { ...query, limit: '5' }, { ...query, sortBy: 'popular' }, { ...query, keywords: {} },
    { ...query, keywords: '   ' }, { ...query, keywords: '!!!' }, { ...query, keywords: 'a'.repeat(151) }, { ...query, keywords: 'AI\nagent' }])
    assert.throws(() => validateSearch(invalid), AppError);
  assert.equal(validateSearch({ ...query, keywords: '  AI   automation ' }).keywords, 'AI automation');
});
test('cache key includes all controls and normalizes keyword spacing and case', () => {
  assert.equal(cacheKey(query), cacheKey(validateSearch({ ...query, keywords: '  ai   AUTOMATION  ' })));
  for (const changed of [{ ...query, limit: 10 }, { ...query, timeRange: '24h' }, { ...query, sortBy: 'relevance' }]) assert.notEqual(cacheKey(query), cacheKey(changed));
});
test('only direct LinkedIn HTTPS source links pass', () => {
  const url = fixture().url;
  assert.equal(linkedinUrl(url + '?tracking=1#top'), url);
  for (const invalid of ['javascript:alert(1)', 'https://linkedin.com.evil.test/posts/x', 'https://evil.test', 'https://www.linkedin.com/in/person',
    'https://www.linkedin.com/posts/', url.replace('https:', 'http:'), url.replace('www.linkedin.com', 'name:password@www.linkedin.com'), url.replace('www.linkedin.com', 'www.linkedin.com:444')]) assert.equal(linkedinUrl(invalid), null);
  assert.equal(linkedinUrl('https://www.linkedin.com/in/test', true), 'https://www.linkedin.com/in/test');
});
test('timestamps never guess timezones, relative times, or seconds', () => {
  assert.equal(timestamp({ date: '2026-09-12T12:00:00Z' }), NOW);
  for (const value of [{ date: '2026-09-12 12:00:00' }, { relative: '1h' }, { timestamp: NOW / 1000 }, {}, { timestamp: Infinity }]) assert.equal(timestamp(value), null);
});
test('normalization removes duplicates, invalid URLs, blank text, missing/future/out-of-range timestamps', () => {
  const normal = fixture(), duplicate = { ...normal, url: normal.url + '?tracking=1' };
  const alias = { ...normal, url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789' };
  const result = normalizePosts([normal, duplicate, alias, { ...normal, url: 'https://evil.test' }, { ...normal, text: ' ' },
    { ...normal, posted_at: {} }, fixture('2234567890123456789', 4 * 86400000), fixture('3234567890123456789', -1000)], query, NOW);
  assert.equal(result.posts.length, 1); assert.deepEqual(result.excluded, { invalid: 2, timestamp: 1, outsideRange: 2, duplicate: 2 });
  assert.equal(result.posts[0].reactions, 0); assert.equal(result.posts[0].authorProfileUrl, null);
});
test('all time windows enforce boundaries and final sorting preserves provider relevance order', () => {
  for (const [timeRange, duration] of Object.entries({ '24h': 86400000, '3d': 259200000, '7d': 604800000 })) {
    assert.equal(normalizePosts([fixture(undefined, duration), fixture('2234567890123456789', duration + 1)], { ...query, timeRange }, NOW).posts.length, 1);
  }
  const items = [fixture('1234567890123456789', 7200000), fixture('2234567890123456789', 3600000)];
  assert.equal(normalizePosts(items, query, NOW).posts[0].id, '2234567890123456789');
  assert.equal(normalizePosts(items, { ...query, sortBy: 'relevance' }, NOW).posts[0].id, '1234567890123456789');
});
test('cache survives restart, empty success is cached, and expired searches use provider once', async t => {
  const cacheFile = await tempCache(t); let calls = 0, time = NOW;
  const options = { cacheFile, now: () => time, provider: { searchPosts: async () => { calls++; return [fixture()]; } } };
  const first = await createDiscovery(options);
  assert.equal((await first.searchPosts(query)).meta.source, 'fresh');
  const restarted = await createDiscovery(options);
  assert.equal((await restarted.searchPosts({ ...query, keywords: 'ai AUTOMATION' })).meta.source, 'cache');
  assert.equal(calls, 1);
  time += TTL + 1;
  assert.equal((await restarted.searchPosts(query)).meta.source, 'fresh'); assert.equal(calls, 2);
  const empty = await createDiscovery({ ...options, cacheFile: await tempCache(t), provider: { searchPosts: async () => { calls++; return []; } } });
  await empty.searchPosts(query); const before = calls; assert.equal((await empty.searchPosts(query)).meta.count, 0); assert.equal(calls, before);
});
test('cached posts age out without another paid call', async t => {
  let time = NOW, calls = 0;
  const discovery = await createDiscovery({ cacheFile: await tempCache(t), now: () => time,
    provider: { searchPosts: async () => { calls++; return [fixture(undefined, 23.5 * 3600000)]; } } });
  const q = { ...query, timeRange: '24h' };
  assert.equal((await discovery.searchPosts(q)).posts.length, 1);
  time += 3600000;
  const cached = await discovery.searchPosts(q);
  assert.equal(cached.posts.length, 0); assert.equal(cached.meta.agedOut, 1); assert.equal(calls, 1);
});
test('one active search rejects concurrent calls before invoking provider', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const discovery = await createDiscovery({ cacheFile: await tempCache(t), now: () => NOW,
    provider: { searchPosts: async () => { calls++; entered(); await gate; return []; } } });
  const first = discovery.searchPosts(query);
  await started;
  await assert.rejects(discovery.searchPosts(query), { code: 'SEARCH_ACTIVE' });
  await assert.rejects(discovery.searchPosts({ ...query, keywords: 'marketing' }), { code: 'SEARCH_ACTIVE' });
  release(); await first; assert.equal(calls, 1);
});
test('failed runs persist a cooldown and are never automatically retried', async t => {
  const cacheFile = await tempCache(t); let calls = 0;
  const options = { cacheFile, now: () => NOW, provider: { searchPosts: async () => { calls++; throw new AppError(502, 'APIFY_CONNECTION_FAILED', 'Offline test'); } } };
  const discovery = await createDiscovery(options);
  await assert.rejects(discovery.searchPosts(query), { code: 'APIFY_CONNECTION_FAILED' });
  await assert.rejects(discovery.searchPosts(query), { code: 'SEARCH_COOLDOWN' });
  const restarted = await createDiscovery(options);
  await assert.rejects(restarted.searchPosts(query), { code: 'SEARCH_COOLDOWN' }); assert.equal(calls, 1);
});
test('bad persistence fails before provider usage', async t => {
  const cacheFile = await tempCache(t);
  await fs.writeFile(cacheFile, 'not json');
  await assert.rejects(createDiscovery({ cacheFile, provider: {} }), { code: 'CACHE_UNAVAILABLE' });
  const blocked = path.join(cacheFile, 'child.json');
  let calls = 0;
  const discovery = await createDiscovery({ cacheFile: await tempCache(t), provider: { searchPosts: async () => { calls++; return []; } } });
  assert.ok(discovery);
  const blockedDiscovery = await createDiscovery({ cacheFile: blocked, provider: { searchPosts: async () => { calls++; return []; } } });
  await assert.rejects(blockedDiscovery.searchPosts(query), { code: 'CACHE_UNAVAILABLE' });
  assert.equal(calls, 0);
});
test('provider sends one verified actor input, auth stays in header, result quantity is bounded', async () => {
  let calls = 0;
  const provider = createProvider({ token: 'TEST_SECRET_ONLY', fetchImpl: async (url, options) => {
    calls++; assert.equal(url.hostname, 'api.apify.com'); assert.ok(url.pathname.includes('apimaestro~linkedin-posts-search-scraper-no-cookies'));
    assert.equal(url.searchParams.get('timeout'), '120'); assert.equal(url.searchParams.get('maxTotalChargeUsd'), '0.05');
    assert.ok(!url.href.includes('TEST_SECRET_ONLY')); assert.equal(options.headers.Authorization, 'Bearer TEST_SECRET_ONLY');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.deepEqual(JSON.parse(options.body), { keyword: 'AI automation', sort_type: 'date_posted', page_number: 1, date_filter: 'past-week', limit: 5 });
    return { ok: true, json: async () => Array.from({ length: 10 }, () => fixture()) };
  } });
  assert.equal((await provider.searchPosts(query)).length, 5); assert.equal(calls, 1);
});
test('provider errors hide secrets and never retry; missing token makes zero network calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('TEST_SECRET_ONLY'); };
  await assert.rejects(createProvider({ token: '', fetchImpl }).searchPosts(query), { code: 'APIFY_NOT_CONFIGURED' });
  assert.equal(calls, 0);
  await assert.rejects(createProvider({ token: 'TEST_SECRET_ONLY', fetchImpl }).searchPosts(query), error => error.code === 'APIFY_CONNECTION_FAILED' && !error.message.includes('TEST_SECRET_ONLY'));
  assert.equal(calls, 1);
  for (const status of [401, 402, 403, 429, 500, 408]) {
    let attempts = 0;
    await assert.rejects(createProvider({ token: 'test', fetchImpl: async () => { attempts++; return { ok: false, status }; } }).searchPosts(query), { code: 'APIFY_REQUEST_FAILED' });
    assert.equal(attempts, 1);
  }
});
test('provider accepts documented envelope but rejects unknown schemas', async () => {
  const provider = data => createProvider({ token: 'test', fetchImpl: async () => ({ ok: true, json: async () => data }) });
  assert.equal((await provider([{ data: { posts: [fixture()] } }]).searchPosts(query)).length, 1);
  for (const data of [{}, [{ unknown: 'shape' }]]) await assert.rejects(provider(data).searchPosts(query), { code: 'APIFY_OUTPUT_CHANGED' });
});
test('HTTP health, static assets, validation, missing token and private files are safe without provider calls', async t => {
  let calls = 0;
  const discovery = await createDiscovery({ cacheFile: await tempCache(t), provider: createProvider({ token: '', fetchImpl: async () => { calls++; throw new Error('Unexpected network'); } }) });
  const url = await serve(t, { discovery, apifyConfigured: false });
  const health = await fetch(url + '/api/health');
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const file of ['/', '/app.js', '/styles.css']) {
    const response = await fetch(url + file); assert.equal(response.status, 200);
    assert.ok(! (await response.text()).includes('TEST_SECRET_ONLY')); assert.ok(response.headers.get('content-security-policy'));
  }
  for (const file of ['/.env', '/src/config/index.js', '/data/search-cache.json', '/package.json', '/server.js']) assert.equal((await fetch(url + file)).status, 404);
  assert.equal((await post(url, { ...query, limit: 11 })).status, 400);
  const missing = await post(url, query); assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, 'APIFY_NOT_CONFIGURED');
  assert.equal((await post(url, query, { origin: 'https://evil.test' })).status, 403);
  const malformed = await fetch(url + '/api/posts/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  assert.equal((await post(url, { ...query, keywords: 'x'.repeat(5000) })).status, 413);
  assert.equal(calls, 0);
});
test('HTTP hides unexpected internal errors', async t => {
  const url = await serve(t, { apifyConfigured: true, discovery: { searchPosts: async () => { throw new Error('TEST_SECRET_ONLY'); } } });
  const response = await post(url, query); assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
});
