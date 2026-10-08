const test = require('node:test');
const assert = require('node:assert/strict');
const { createFacebookProvider } = require('../src/services/providers/facebook');
const { createInstagramProvider } = require('../src/services/providers/instagram');
const { normalizePosts } = require('../src/utils/posts');
const NOW = Date.parse('2026-09-12T12:00:00Z');
const query = { platform: 'facebook', keywords: 'ATS Resume', searchMode: 'simple', match: 'all', timeRange: '7d', limit: 5, sortBy: 'relevance' };
test('Facebook and Instagram providers normalize public permalinks with bounded actor calls', async () => {
  let calls = 0; const fetchImpl = async (url, options) => { calls++; assert.equal(url.searchParams.get('maxTotalChargeUsd'), '0.05'); assert.equal(url.searchParams.get('maxItems'), '5'); assert.equal(options.redirect, 'error'); return { ok: true, json: async () => [{ post_id: 'fb1', message: 'ATS Resume advice', post_url: 'https://www.facebook.com/example/posts/123', created_time: new Date(NOW - 1000).toISOString(), author: { name: 'Page' } }] }; };
  const fb = await createFacebookProvider({ token: 'test', fetchImpl }).searchPosts(query); assert.equal(normalizePosts(fb, query, NOW).posts[0].platform, 'facebook');
  const ig = await createInstagramProvider({ token: 'test', fetchImpl: async () => ({ ok: true, json: async () => [{ shortcode: 'abc123', caption: 'ATS Resume tips', timestamp: new Date(NOW - 1000).toISOString(), username: 'creator' }] }) }).searchPosts({ ...query, platform: 'instagram' });
  assert.equal(normalizePosts(ig, { ...query, platform: 'instagram' }, NOW).posts[0].postUrl, 'https://www.instagram.com/p/abc123'); assert.equal(calls, 1);
});
