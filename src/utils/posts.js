const { createHash } = require('node:crypto');

// FEATURE/FUNCTION: Public errors.
// PURPOSE: Expose controlled messages without provider secrets.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ranges = {
  '24h': 86400000,
  '3d': 259200000,
  '7d': 604800000,
};

// FEATURE/FUNCTION: Search validation.
// PURPOSE: Enforce scope before any provider request.
function validateSearch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      400,
      'INVALID_SEARCH',
      'Provide a JSON search object.'
    );
  }

  const { platform, keywords, timeRange, limit, sortBy, searchMode = 'simple', match = 'all' } = body;

  const normalized = typeof keywords === 'string'
    ? keywords.normalize('NFKC').trim().replace(/\s+/g, ' ')
    : '';

  if (
    !['linkedin', 'facebook', 'instagram'].includes(platform) ||
    !Object.hasOwn(ranges, timeRange) ||
    ![5, 10, 15, 20, 25, 30].includes(limit) ||
    !['newest', 'relevance'].includes(sortBy) ||
    !['simple', 'advanced'].includes(searchMode) ||
    !['all', 'any'].includes(match)
  ) {
    throw new AppError(
      400,
      'INVALID_SEARCH',
      'Choose LinkedIn, Facebook, or Instagram, a valid search mode, 24h/3d/7d, 5–30 results, and newest or relevance.'
    );
  }

  if (
    normalized.length < 2 ||
    normalized.length > 150 ||
    !/[\p{L}\p{N}]{2}/u.test(normalized) ||
    /[\x00-\x1f\x7f]/.test(keywords)
  ) {
    throw new AppError(
      400,
      'INVALID_KEYWORDS',
      'Enter meaningful keywords between 2 and 150 characters, without control characters.'
    );
  }

  return {
    platform,
    keywords: normalized,
    searchMode,
    match,
    timeRange,
    limit,
    sortBy,
  };
}

// FEATURE/FUNCTION: Cache identity.
// PURPOSE: Share searches regardless of keyword case or spacing.
function cacheKey(query) {
  return createHash('sha256')
    .update(JSON.stringify([
      query.platform,
      query.searchMode || 'simple',
      query.match || 'all',
      query.keywords.toLowerCase(),
      query.timeRange,
      query.limit,
      query.sortBy,
    ]))
    .digest('hex');
}

// FEATURE/FUNCTION: URL validation.
// PURPOSE: Accept only direct HTTPS LinkedIn post or profile links.
function linkedinUrl(value, profile = false) {
  try {
    if (typeof value !== 'string') return null;

    const url = new URL(value);

    if (
      url.protocol !== 'https:' ||
      !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }

    const valid = profile
      ? /^\/(in|company)\/[^/]+\/?$/
      : /^\/(?:posts\/[A-Za-z0-9_%.-]+-activity-\d{10,25}(?:-[A-Za-z0-9_-]+)?|feed\/update\/urn:li:(?:activity|share|ugcPost):\d{10,25})\/?$/;

    if (!valid.test(url.pathname)) return null;

    return 'https://www.linkedin.com' +
      url.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}

const cleanText = value =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : null;

const count = value =>
  Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

// FEATURE/FUNCTION: Timestamp parsing.
// PURPOSE: Use Unix milliseconds or zoned ISO dates, never relative guesses.
function timestamp(posted) {
  if (!posted || typeof posted !== 'object') return null;

  if (
    typeof posted.timestamp === 'number' &&
    Number.isFinite(posted.timestamp) &&
    posted.timestamp >= 1000000000000 &&
    posted.timestamp < 8640000000000000
  ) {
    return posted.timestamp;
  }

  if (
    typeof posted.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(posted.date)
  ) {
    const value = Date.parse(posted.date);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

// FEATURE/FUNCTION: Normalization.
// PURPOSE: Map actual Apify fields and remove unverifiable opportunities.
function normalizePosts(items, query, now = Date.now()) {
  const posts = [];
  const urls = new Set();
  const ids = new Set();

  const excluded = {
    invalid: 0,
    timestamp: 0,
    outsideRange: 0,
    duplicate: 0,
  };

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      excluded.invalid++;
      continue;
    }

    const platform = item.platform || query.platform;
    const postUrl = platform === 'linkedin' ? linkedinUrl(item.post_url || item.url) : cleanUrl(platform, item.postUrl || item.post_url || item.url || item.link || item.permalink);
    const postText = cleanText(item.postText || item.text || item.caption || item.message || item.description);

    if (
      !postUrl ||
      !postText ||
      !/[\p{L}\p{N}]{2}/u.test(postText)
    ) {
      excluded.invalid++;
      continue;
    }

    const published = item.publishedAt ? Date.parse(item.publishedAt) : timestamp(item.posted_at || item.created_time || item.timestamp);

    if (!Number.isFinite(published)) {
      excluded.timestamp++;
      continue;
    }

    if (
      published > now ||
      published < now - ranges[query.timeRange]
    ) {
      excluded.outsideRange++;
      continue;
    }

    const id = cleanText(item.id) || postUrl.match(
      /(?:activity-|urn:li:(?:activity|share|ugcPost):)(\d+)/
    )?.[1] || postUrl;

    if (urls.has(postUrl) || ids.has(id)) {
      excluded.duplicate++;
      continue;
    }

    urls.add(postUrl);
    ids.add(id);

    const author = item.author || {};

    const authorName =
      cleanText(item.authorName) || cleanText(author.name) ||
      cleanText([
        cleanText(author.first_name),
        cleanText(author.last_name),
      ].filter(Boolean).join(' '));

    posts.push({
      id,
      platform,
      authorName,
      authorHeadline: cleanText(item.authorHeadline || author.headline),
      authorProfileUrl: platform === 'linkedin' ? linkedinUrl(author.profile_url, true) : cleanUrl(platform, item.authorProfileUrl || author.profile_url || author.url),
      postText,
      postUrl,
      publishedAt: new Date(published).toISOString(),
      relativeTime: cleanText(
        item.posted_at?.display_text ||
        item.posted_at?.relative
      ),
      reactions: count(item.reactions ?? item.likesCount ?? item.likes ?? item.stats?.total_reactions),
      commentsCount: count(item.commentsCount ?? item.comments ?? item.comments_count ?? item.stats?.comments),
      relevanceScore: 0,
      relevanceReason: 'Returned by LinkedIn keyword search via Apify; local relevance screening applied.',
      sourceProvider: item.sourceProvider || 'apify',
    });
  }

  if (query.sortBy === 'newest') {
    posts.sort(
      (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    );
  }

  // Relevance gets rescored by discovery after Boolean validation.
  return {
    posts: posts.slice(0, query.limit),
    excluded,
  };
}

function cleanUrl(platform, value) {
  try {
    const url = new URL(value); const hosts = { facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com'], instagram: ['instagram.com', 'www.instagram.com'] };
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts[platform]?.includes(url.hostname)) return null;
    if (platform === 'instagram' && !/^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    if (platform === 'facebook' && !/^\/(?:[^/]+\/posts\/[^/]+|groups\/[^/]+\/(?:posts|permalink)\/\d+|reel\/\d+|[^/]+\/videos\/\d+|permalink\.php|story\.php)\/?$/.test(url.pathname)) return null;
    return 'https://' + (platform === 'instagram' ? 'www.instagram.com' : 'www.facebook.com') + url.pathname.replace(/\/$/, '') + (platform === 'facebook' && url.search ? url.search : '');
  } catch { return null; }
}

module.exports = {
  AppError,
  ranges,
  validateSearch,
  cacheKey,
  linkedinUrl,
  cleanUrl,
  timestamp,
  normalizePosts,
};
