const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError, validateSearch, cacheKey, normalizePosts, ranges } = require('../utils/posts');
const { parseBooleanQuery, evaluateBoolean, scoreRelevance } = require('../utils/boolean-search');
const TTL = 6 * 60 * 60 * 1000;
// FEATURE/FUNCTION: Durable search store. PURPOSE: Preserve searches and usage guards across restarts.
async function createDiscovery({ provider, cacheFile, now = Date.now }) {
  let state = { version: 1, entries: {}, attempts: {}, blockedUntil: 0 }, active = false;
  try {
    const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (saved.version !== 1 || !saved.entries || !saved.attempts) throw new Error('Invalid cache');
    state = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new AppError(503, 'CACHE_UNAVAILABLE', 'The local cache cannot be read. Restore or rename data/search-cache.json before starting.');
  }
  // FEATURE/FUNCTION: Atomic persistence. PURPOSE: Commit usage guards before spending and keep completed searches reusable.
  async function persist() {
    const current = now();
    for (const [key, value] of Object.entries(state.entries)) if (current - value.createdAt >= TTL) delete state.entries[key];
    for (const [key, value] of Object.entries(state.attempts)) if (value <= current) delete state.attempts[key];
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    await fs.rename(cacheFile + '.tmp', cacheFile);
  }
  // FEATURE/FUNCTION: Cached response. PURPOSE: Reapply rolling time windows to cached posts.
  function result(entry, query, source) {
    const posts = entry.posts.filter(post => Date.parse(post.publishedAt) >= now() - ranges[query.timeRange] && Date.parse(post.publishedAt) <= now());
    return { posts, meta: { source, searchId: cacheKey(query), count: posts.length, requested: query.limit, searchedAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.createdAt + TTL).toISOString(), excluded: entry.excluded, agedOut: entry.posts.length - posts.length } };
  }
  return {
    // FEATURE/FUNCTION: Cache reference status. PURPOSE: Return only genuine expiry information without invoking the provider.
    cacheStatus(searchId) {
      if (typeof searchId !== 'string' || !/^[a-f0-9]{64}$/.test(searchId)) throw new AppError(400, 'INVALID_SEARCH_REFERENCE', 'This saved search reference is invalid.');
      const entry = state.entries[searchId];
      if (!entry || now() - entry.createdAt >= TTL) throw new AppError(410, 'SEARCH_CACHE_UNAVAILABLE', 'Saved posts remain viewable. Generating comments or alternatives requires an explicit new search.');
      return { available: true, expiresAt: new Date(entry.createdAt + TTL).toISOString() };
    },
    // FEATURE/FUNCTION: Trusted cached posts. PURPOSE: Resolve IDs without browser replacement text or paid discovery.
    getCachedPosts(searchId, postIds) {
      if (typeof searchId !== 'string' || !/^[a-f0-9]{64}$/.test(searchId) || !Array.isArray(postIds) || postIds.length < 1 || postIds.length > 10 ||
          postIds.some(id => typeof id !== 'string') || new Set(postIds).size !== postIds.length)
        throw new AppError(400, 'INVALID_POST_SELECTION', 'Select 1–10 unique post IDs from an existing search.');
      const entry = state.entries[searchId];
      if (!entry || now() - entry.createdAt >= TTL) throw new AppError(410, 'SEARCH_CACHE_UNAVAILABLE', 'This search is no longer cached. No discovery was run. Use manual input or explicitly choose a new search.');
      const selected = postIds.map(id => entry.posts.find(post => post.id === id));
      if (selected.some(post => !post)) throw new AppError(400, 'UNKNOWN_POST_ID', 'A selected post does not belong to this cached search.');
      return selected.map(post => ({ ...post }));
    },
    // FEATURE/FUNCTION: Search coordinator. PURPOSE: Serialize searches, use cache, and prevent duplicate spending.
    async searchPosts(body) {
      const query = validateSearch(body), key = cacheKey(query);
      // FEATURE/FUNCTION: Search expression. PURPOSE: Convert simple ALL/ANY controls and parse advanced Boolean input safely.
      const expression = query.searchMode === 'simple'
        ? query.keywords.split(/[,\s]+/).filter(Boolean).join(query.match === 'all' ? ' AND ' : ' OR ')
        : query.keywords;
      const ast = parseBooleanQuery(expression);
      if (active) throw new AppError(409, 'SEARCH_ACTIVE', 'A search is already running. Wait for it to finish.');
      const cached = state.entries[key];
      if (cached && now() - cached.createdAt < TTL) return result(cached, query, 'cache');
      if (state.blockedUntil > now() || state.attempts[key] > now()) throw new AppError(429, 'SEARCH_COOLDOWN', 'Search protection is active. Wait a few minutes; if the last search failed, check Apify Console first.');
      active = true;
      try {
        state.attempts[key] = now() + 30000;
        state.blockedUntil = now() + 150000;
        try { await persist(); } catch { throw new AppError(503, 'CACHE_UNAVAILABLE', 'Cannot save the usage guard. No provider request was started. Check data directory permissions.'); }
        const providerQuery = { ...query, providerKeywords: expression };
        const adapter = typeof provider.searchPosts === 'function' ? provider : provider[query.platform];
        if (!adapter) throw new AppError(503, 'PLATFORM_UNAVAILABLE', `${query.platform} discovery is temporarily unavailable. LinkedIn and saved results are still available.`);
        const items = await adapter.searchPosts(providerQuery);
        const normalized = normalizePosts(items, { ...query, limit: Math.max(query.limit, items.length) }, now());
        const booleanExcluded = normalized.posts.filter(post => !evaluateBoolean(ast, post.postText)).length;
        const posts = normalized.posts.filter(post => evaluateBoolean(ast, post.postText)).map(post => ({ ...post, relevanceScore: scoreRelevance(ast, post.postText) }));
        if (query.sortBy === 'relevance') posts.sort((a, b) => b.relevanceScore - a.relevanceScore || (b.reactions || 0) - (a.reactions || 0) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
        else posts.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
        const entry = { createdAt: now(), posts: posts.slice(0, query.limit), excluded: { ...normalized.excluded, boolean: booleanExcluded } };
        state.entries[key] = entry;
        state.blockedUntil = 0;
        let warning;
        try { await persist(); } catch { warning = 'Results are cached in memory but could not be saved to disk. Fix data directory permissions before restarting.'; }
        return { ...result(entry, query, 'fresh'), ...(warning ? { warning } : {}) };
      } catch (error) {
        // Preserve the disk guard after ambiguous failures; never start a replacement run.
        if (error.code === 'APIFY_NOT_CONFIGURED') state.blockedUntil = 0;
        throw error;
      } finally { active = false; }
    },
  };
}
module.exports = { createDiscovery, TTL };
