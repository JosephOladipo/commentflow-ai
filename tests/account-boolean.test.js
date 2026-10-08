const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseBooleanQuery, evaluateBoolean, scoreRelevance } = require('../src/utils/boolean-search');
const { createAccountStore } = require('../src/services/account-store');

test('Boolean parser handles phrases, precedence, exclusion, and malformed input without evaluation', () => {
  const expression = parseBooleanQuery('(AI OR automation) AND "social media" NOT spam');
  assert.equal(evaluateBoolean(expression, 'AI improves social media planning.'), true);
  assert.equal(evaluateBoolean(expression, 'Automation for social media spam.'), false);
  assert.equal(evaluateBoolean(expression, 'A general AI update.'), false);
  assert.ok(scoreRelevance(expression, 'AI and social media automation') > 0);
  for (const invalid of ['AI AND', '(AI OR marketing', '"unfinished', 'AI OR )']) assert.throws(() => parseBooleanQuery(invalid), { code: 'INVALID_BOOLEAN_QUERY' });
});

test('account store deduplicates posts, preserves statuses and persists generated comments', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commentflow-account-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-09-12T12:00:00Z');
  const file = path.join(dir, 'account.json');
  const store = await createAccountStore({ file, now: () => time });
  const post = { id: '123', platform: 'linkedin', postText: 'Useful AI automation advice', postUrl: 'https://www.linkedin.com/posts/a-activity-123', authorName: 'A', publishedAt: new Date(time).toISOString() };
  await store.recordSearch('owner', { keywords: 'AI automation', platform: 'linkedin', limit: 5, timeRange: '7d', sortBy: 'relevance' }, [post]);
  time += 1000;
  await store.recordSearch('owner', { keywords: 'AI automation', platform: 'linkedin', limit: 5, timeRange: '7d', sortBy: 'relevance' }, [post]);
  await store.markViewed('owner', 'linkedin:123');
  await store.recordComments('owner', [{ platform: 'linkedin', postId: '123', comment: 'Helpful point.' }], 'test-model');
  await store.markCommented('owner', 'linkedin:123');
  const saved = store.saved('owner', { status: 'COMMENTED' });
  assert.equal(saved.length, 1); assert.equal(saved[0].timesDiscovered, 2); assert.equal(saved[0].commentHistory[0].commentText, 'Helpful point.');
  const restarted = await createAccountStore({ file, now: () => time });
  assert.equal(restarted.analytics('owner').commentsToday, 1);
  assert.equal(restarted.searches('owner').length, 2);
});
