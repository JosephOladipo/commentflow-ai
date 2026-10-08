const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('../utils/posts');

// FEATURE/FUNCTION: Account history store. PURPOSE: Keep one owner's engagement history durable without external infrastructure.
async function createAccountStore({ file, now = Date.now }) {
  let data = { version: 1, accounts: {} };
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); if (data.version !== 1 || !data.accounts) throw new Error(); }
  catch (error) { if (error.code !== 'ENOENT') throw new AppError(503, 'ACCOUNT_STORE_UNAVAILABLE', 'Cannot read the account history store.'); }
  const account = owner => data.accounts[owner] ||= { posts: {}, searches: [], comments: {}, settings: { dailyGoal: 20 } };
  async function save() { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file + '.tmp', JSON.stringify(data), { mode: 0o600 }); await fs.rename(file + '.tmp', file); }
  // FEATURE/FUNCTION: Upsert discovery. PURPOSE: Preserve one record per stable platform post identity across searches.
  async function recordSearch(owner, query, posts) {
    const item = account(owner), stamp = new Date(now()).toISOString(), ids = [];
    for (const post of posts) {
      const key = post.platform + ':' + post.id, prior = item.posts[key]; ids.push(key);
      item.posts[key] = { ...(prior || {}), ...post, firstDiscoveredAt: prior?.firstDiscoveredAt || stamp, lastDiscoveredAt: stamp,
        timesDiscovered: (prior?.timesDiscovered || 0) + 1, status: prior?.status || 'NEW', firstViewedAt: prior?.firstViewedAt || null,
        lastViewedAt: prior?.lastViewedAt || null, viewCount: prior?.viewCount || 0, commentedAt: prior?.commentedAt || null };
      if (item.comments[key]?.length) item.posts[key].status = item.posts[key].commentedAt ? 'COMMENTED' : 'COMMENT_GENERATED';
    }
    item.searches.unshift({ id: String(now()) + '-' + Math.random().toString(16).slice(2), query: query.keywords, platform: query.platform,
      searchMode: query.searchMode || 'simple', timeRange: query.timeRange, requestedLimit: query.limit, sortBy: query.sortBy, searchedAt: stamp, resultPostIds: ids });
    item.searches = item.searches.slice(0, 200); await save();
    return ids.map(key => ({ key, ...item.posts[key], status: statuses(item.posts[key]), commentHistory: item.comments[key] || [] }));
  }
  function statuses(post) { return post.commentedAt ? 'COMMENTED' : post.status === 'COMMENT_GENERATED' ? 'COMMENT_GENERATED' : post.viewCount ? 'VIEWED' : 'NEW'; }
  return {
    async recordSearch(owner, query, posts) { return recordSearch(owner, query, posts); },
    async upsertManual(owner, posts) { return recordSearch(owner, { keywords: 'Manual post', platform: posts[0]?.platform || 'linkedin', searchMode: 'simple', timeRange: 'manual', limit: 1, sortBy: 'relevance' }, posts); },
    async markViewed(owner, key) { const post = account(owner).posts[key]; if (!post) throw new AppError(404, 'POST_NOT_FOUND', 'Saved post not found.'); const stamp = new Date(now()).toISOString(); post.firstViewedAt ||= stamp; post.lastViewedAt = stamp; post.viewCount = (post.viewCount || 0) + 1; post.status = post.commentedAt ? 'COMMENTED' : 'VIEWED'; await save(); return post; },
    async markCommented(owner, key, commented = true) { const post = account(owner).posts[key]; if (!post) throw new AppError(404, 'POST_NOT_FOUND', 'Saved post not found.'); post.commentedAt = commented ? new Date(now()).toISOString() : null; post.status = commented ? 'COMMENTED' : (account(owner).comments[key]?.length ? 'COMMENT_GENERATED' : 'VIEWED'); await save(); return post; },
    async recordComments(owner, results, model) { const item = account(owner), stamp = new Date(now()).toISOString(); for (const result of results) { const key = result.platform + ':' + result.postId; if (!item.posts[key]) continue; const versions = item.comments[key] ||= []; if (!versions.some(version => version.commentText === result.comment)) versions.push({ postId: result.postId, commentText: result.comment, createdAt: stamp, model, version: versions.length + 1, selected: false }); item.posts[key].status = item.posts[key].commentedAt ? 'COMMENTED' : 'COMMENT_GENERATED'; } await save(); },
    saved(owner, filters = {}) {
      const item = account(owner);
      const since = filters.date === '7d' ? now() - 7 * 86400000 : filters.date === '30d' ? now() - 30 * 86400000 : filters.date === 'today' ? new Date(new Date(now()).toDateString()).getTime() : 0;
      return Object.entries(item.posts)
        .map(([key, post]) => ({ key, ...post, status: statuses(post), commentHistory: item.comments[key] || [] }))
        .filter(post => {
          const text = (post.postText + ' ' + (post.authorName || '')).toLocaleLowerCase();
          return (!filters.status || filters.status === 'all' || post.status === filters.status)
            && (!filters.platform || filters.platform === 'all' || post.platform === filters.platform)
            && (!filters.text || text.includes(filters.text.toLocaleLowerCase()))
            && (!since || Date.parse(post.lastDiscoveredAt) >= since);
        });
    },
    search(owner, id) { const entry = account(owner).searches.find(item => item.id === id); if (!entry) throw new AppError(404, 'SEARCH_HISTORY_NOT_FOUND', 'Saved search not found.'); return { ...entry, posts: entry.resultPostIds.map(key => account(owner).posts[key]).filter(Boolean) }; },
    searches(owner) { return account(owner).searches.map(({ resultPostIds, ...entry }) => ({ ...entry, resultCount: resultPostIds.length })); },
    analytics(owner) { const item = account(owner), posts = Object.values(item.posts), start = new Date(now()); const day = start.toISOString().slice(0, 10); const week = now() - 7 * 86400000, month = now() - 30 * 86400000; const count = since => posts.filter(p => p.commentedAt && Date.parse(p.commentedAt) >= since).length; const platformCounts = Object.fromEntries(['linkedin', 'facebook', 'instagram'].map(platform => [platform, posts.filter(p => p.platform === platform && p.commentedAt).length])); return { dailyGoal: item.settings.dailyGoal || 20, commentsToday: posts.filter(p => p.commentedAt?.slice(0, 10) === day).length, commentsThisWeek: count(week), commentsThisMonth: count(month), totalComments: posts.filter(p => p.commentedAt).length, platformCounts, postsDiscovered: posts.length, postsViewed: posts.filter(p => p.viewCount).length, commentsGenerated: posts.filter(p => item.comments[p.platform + ':' + p.id]?.length).length, postsCommented: posts.filter(p => p.commentedAt).length, recentActivity: [...posts].sort((a,b) => Date.parse(b.lastDiscoveredAt) - Date.parse(a.lastDiscoveredAt)).slice(0, 12) }; },
    async settings(owner, settings) { const item = account(owner); if (settings && (!Number.isInteger(settings.dailyGoal) || settings.dailyGoal < 1 || settings.dailyGoal > 200)) throw new AppError(400, 'INVALID_GOAL', 'Daily goal must be between 1 and 200.'); if (settings) { item.settings.dailyGoal = settings.dailyGoal; await save(); } return item.settings; },
  };
}
module.exports = { createAccountStore };
