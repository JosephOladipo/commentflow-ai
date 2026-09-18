const test = require('node:test');
const { testAuth, loginTestServer, authenticatedFetch: fetch } = require('./support/session');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { normalizePosts } = require('../src/utils/posts');
const { validateManual, manualUrl, validateComments } = require('../src/utils/comments');
const { createDiscovery, TTL } = require('../src/services/discovery');
const { createCommentService } = require('../src/services/comments');
const { createProvider } = require('../src/services/apify');
const { createApp } = require('../src/routes/app');
const NOW = Date.parse('2026-09-12T12:00:00Z');
const query = { platform: 'linkedin', keywords: 'automation', timeRange: '7d', limit: 5, sortBy: 'relevance' };
const raw = id => ({ post_url: 'https://www.linkedin.com/posts/test_automation-activity-' + id + '-AbCd',
  text: 'Document each handoff in your workflow before automating it. Define who owns each exception.',
  author: { name: 'Test Author' }, posted_at: { timestamp: NOW - 3600000, display_text: '1h' }, stats: { total_reactions: 2, comments: 0 } });
const draft = id => ({ postId: id, comment: 'Defining ownership for exceptions makes the handoff clearer. Which exceptions would you keep with a person before automating the rest of the workflow?', relevanceReason: 'Addresses workflow handoffs and exception ownership.', suitable: true });
// FEATURE/FUNCTION: Mocked comment fixture. PURPOSE: Exercise complete service flows without any live network.
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commentflow-comments-'));
  t.after(async () => {
    const target = path.resolve(dir), root = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(root) || !path.basename(target).startsWith('commentflow-comments-')) throw new Error('Unsafe test path');
    await fs.rm(target, { recursive: true, force: true });
  });
  let apifyCalls = 0, aiCalls = 0, time = NOW; const requests = [];
  const discovery = await createDiscovery({ cacheFile: path.join(dir, 'search.json'), now: () => time,
    provider: { searchPosts: async () => { apifyCalls++; return [raw('1234567890123456789'), raw('2234567890123456789')]; } } });
  const search = await discovery.searchPosts(query);
  const client = { chat: { completions: { parse: async (body, config) => {
    aiCalls++; requests.push({ body, config });
    if (options.fail) throw Object.assign(new Error('TEST_SECRET_SHOULD_NOT_LEAK'), { status: options.fail });
    const data = JSON.parse(body.messages[1].content);
    const comments = data.posts.map(post => draft(post.postId));
    return { choices: [{ finish_reason: 'stop', message: { parsed: { comments: options.output ? options.output(comments) : comments } } }] };
  } } } };
  const serviceOptions = { apiKey: options.missingKey ? '' : 'TEST_KEY', model: 'gpt-4.1-mini', cacheFile: path.join(dir, 'comments.json'), discovery, client };
  const comments = await createCommentService(serviceOptions);
  return { discovery, search, comments, serviceOptions, requests, counts: () => ({ apifyCalls, aiCalls }), advance: amount => { time += amount; },
    body: { mode: 'linkedin', searchId: search.meta.searchId, postIds: search.posts.map(post => post.id), settings: { name: 'Test', description: 'Workflow expertise', tone: 'friendly', style: 'useful addition' } } };
}
test('actual flat Apify fields are preserved through adapter and normalization', async () => {
  let calls = 0;
  const provider = createProvider({ token: 'test', fetchImpl: async () => { calls++; return { ok: true, json: async () => [raw('1234567890123456789')] }; } });
  const results = normalizePosts(await provider.searchPosts(query), query, NOW).posts;
  assert.equal(results[0].authorName, 'Test Author'); assert.equal(results[0].relativeTime, '1h');
  assert.equal(results[0].postUrl, raw('1234567890123456789').post_url); assert.equal(calls, 1);
});
test('one OpenAI batch maps outputs to trusted IDs and never invokes Apify', async t => {
  const f = await setup(t); const before = f.counts().apifyCalls;
  const result = await f.comments.generate(f.body);
  assert.equal(result.comments.length, 2); assert.equal(f.counts().aiCalls, 1); assert.equal(f.counts().apifyCalls, before);
  assert.equal(result.comments[0].postUrl, f.search.posts[0].postUrl);
  const { body, config } = f.requests[0];
  assert.equal(body.response_format.json_schema.strict, true); assert.equal(config.maxRetries, 0); assert.equal(config.timeout, 45000);
  assert.ok(body.max_completion_tokens <= 4000); assert.equal(body.store, false);
  assert.ok(!body.messages[1].content.includes('postUrl')); assert.ok(body.messages[0].content.includes('untrusted'));
  assert.equal(JSON.parse(body.messages[1].content).posts[0].postText, f.search.posts[0].postText);
});
test('unknown and duplicate model IDs, extra fields, and incomplete batches are rejected', async t => {
  for (const output of [items => [{ ...items[0], postId: 'unknown' }, items[1]], items => [items[0], items[0]], items => [items[0]], items => items.map(item => ({ ...item, postUrl: 'https://evil.test' }))]) {
    const f = await setup(t, { output }); await assert.rejects(f.comments.generate(f.body), { code: 'INVALID_AI_OUTPUT' });
    assert.equal(f.counts().aiCalls, 1);
  }
});
test('server rejects browser content overrides, unknown selections, expired searches and oversized batches without AI usage', async t => {
  const f = await setup(t);
  await assert.rejects(f.comments.generate({ ...f.body, postText: 'replacement' }), { code: 'TRUSTED_CONTENT_REQUIRED' });
  for (const postIds of [[], Array(11).fill('one'), ['unknown'], [f.body.postIds[0], f.body.postIds[0]]]) {
    await assert.rejects(f.comments.generate({ ...f.body, postIds }));
  }
  f.advance(TTL + 1);
  await assert.rejects(f.comments.generate(f.body), { code: 'SEARCH_CACHE_UNAVAILABLE' });
  assert.equal(f.counts().aiCalls, 0); assert.equal(f.counts().apifyCalls, 1);
});
test('missing OpenAI key performs zero AI requests and preserves discovery cache', async t => {
  const f = await setup(t, { missingKey: true });
  await assert.rejects(f.comments.generate(f.body), { code: 'OPENAI_NOT_CONFIGURED' });
  assert.equal(f.counts().aiCalls, 0); assert.equal((await f.discovery.searchPosts(query)).meta.source, 'cache');
});
test('AI failures preserve discovered posts and expose no credential details', async t => {
  const f = await setup(t, { fail: 500 });
  await assert.rejects(f.comments.generate(f.body), error => error.code === 'OPENAI_REQUEST_FAILED' && !error.message.includes('TEST_SECRET'));
  assert.deepEqual(f.discovery.getCachedPosts(f.body.searchId, f.body.postIds), f.search.posts);
  assert.equal(f.counts().aiCalls, 1); assert.equal(f.counts().apifyCalls, 1);
});
test('comment cache persists across restart and is sensitive to tone and content', async t => {
  const f = await setup(t);
  await f.comments.generate(f.body);
  assert.equal((await f.comments.generate(f.body)).meta.source, 'cache');
  const restarted = await createCommentService(f.serviceOptions);
  assert.equal((await restarted.generate(f.body)).meta.source, 'cache'); assert.equal(f.counts().aiCalls, 1);
  await restarted.generate({ ...f.body, settings: { ...f.body.settings, tone: 'professional' } });
  assert.equal(f.counts().aiCalls, 2);
  const manual = { mode: 'manual', manual: { platform: 'x', postUrl: 'https://x.com/test/status/1234567890', postText: raw('1').text } };
  await restarted.generate(manual); await restarted.generate({ ...manual, manual: { ...manual.manual, postText: manual.manual.postText + ' New detail.' } });
  assert.equal(f.counts().aiCalls, 4);
});
test('alternative is one fresh call for one post with previous draft and no discovery', async t => {
  const f = await setup(t); await f.comments.generate(f.body);
  await assert.rejects(f.comments.generate({ ...f.body, alternative: true, previousDraft: 'old' }), { code: 'INVALID_ALTERNATIVE' });
  const body = { ...f.body, postIds: [f.body.postIds[0]], alternative: true, previousDraft: 'Previously edited draft' };
  await f.comments.generate(body);
  assert.equal(f.counts().aiCalls, 2); assert.equal(f.counts().apifyCalls, 1);
  assert.equal(JSON.parse(f.requests[1].body.messages[1].content).previousDraft, body.previousDraft);
});
test('manual platform and source paths reject unrelated domains, credentials, short links and unsafe schemes', () => {
  for (const [platform, url] of [['facebook', 'https://www.facebook.com/test/posts/12345'], ['facebook', 'https://facebook.com/permalink.php?story_fbid=123&id=456'],
    ['instagram', 'https://instagram.com/p/AbC_12/'], ['x', 'https://twitter.com/test/status/1234567890'], ['linkedin', raw('1234567890123456789').post_url]]) assert.ok(manualUrl(platform, url));
  for (const [platform, url] of [['instagram', 'https://instagram.com/user'], ['x', 'https://t.co/abc'], ['facebook', 'https://facebook.com'],
    ['x', 'https://x.com.evil.test/test/status/123456'], ['x', 'https://name:secret@x.com/test/status/123456'], ['x', 'http://x.com/test/status/123456'],
    ['x', 'https://x.com:444/test/status/123456'], ['x', 'javascript:alert(1)'], ['unsupported', 'https://x.com/test/status/123456']]) assert.equal(manualUrl(platform, url), null);
  assert.throws(() => validateManual({ platform: 'x', postUrl: 'https://x.com/test/status/123456', postText: 'short' }), { code: 'INVALID_POST_TEXT' });
});
test('X output is capped at 280 characters and unsuitable output cannot contain a forced comment', () => {
  const post = { id: 'x1', platform: 'x', postUrl: 'https://x.com/test/status/123456' };
  assert.equal(validateComments({ comments: [{ ...draft('x1'), comment: 'a'.repeat(280) }] }, [post]).length, 1);
  for (const item of [{ ...draft('x1'), comment: 'a'.repeat(281) }, { ...draft('x1'), suitable: false }, { ...draft('x1'), comment: '#promotion' }])
    assert.throws(() => validateComments({ comments: [item] }, [post]), { code: 'INVALID_AI_OUTPUT' });
});
test('manual generation does not call or require discovery', async t => {
  const f = await setup(t); const service = await createCommentService({ ...f.serviceOptions, discovery: { getCachedPosts() { throw Error('Must not use discovery'); } } });
  const response = await service.generate({ mode: 'manual', manual: { platform: 'instagram', postUrl: 'https://instagram.com/p/AbC12/', postText: raw('1').text } });
  assert.equal(response.posts[0].sourceProvider, 'manual'); assert.equal(f.counts().aiCalls, 1); assert.equal(f.counts().apifyCalls, 1);
});
test('comment HTTP route reports failures independently and health exposes only configuration booleans', async t => {
  const f = await setup(t, { fail: 429 });
  const app = createApp({ discovery: f.discovery, comments: f.comments, apifyConfigured: true, openaiConfigured: true, auth: testAuth });
  t.after(() => app.locals.sessionStore.stopInterval());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  await loginTestServer(url);
  const response = await fetch(url + '/api/comments/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.body) });
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'OPENAI_REQUEST_FAILED');
  const health = await (await fetch(url + '/api/health')).json();
  assert.deepEqual(health, { status: 'ok' });
  assert.deepEqual(await (await fetch(url + '/api/config')).json(), { apifyConfigured: true, openaiConfigured: true });
  assert.deepEqual(f.discovery.getCachedPosts(f.body.searchId, f.body.postIds), f.search.posts);
});
