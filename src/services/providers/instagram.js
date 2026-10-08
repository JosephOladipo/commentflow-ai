const { createPublicProvider } = require('./apify-public');
const ACTOR = 'scraping_solutions~instagram-boolean-search-scraper-posts-reels';
function createInstagramProvider({ token, actor = ACTOR, fetchImpl }) {
  return createPublicProvider({ token, actor, platform: 'instagram', fetchImpl,
    inputFor: query => ({ query: query.expression, search: query.expression, maxItems: query.limit, resultsLimit: query.limit, includeReels: true }),
    map: item => ({ id: String(item.id || item.shortcode || item.pk || ''), platform: 'instagram', authorName: item.ownerUsername || item.username || item.owner?.username,
      authorHeadline: item.authorHeadline || null, authorProfileUrl: item.authorProfileUrl || (item.ownerUsername ? 'https://www.instagram.com/' + item.ownerUsername : null),
      postText: item.caption || item.text || item.captionText || item.description, postUrl: item.postUrl || item.url || item.permalink || (item.shortcode ? 'https://www.instagram.com/' + (item.isReel ? 'reel/' : 'p/') + item.shortcode : null),
      publishedAt: item.publishedAt || item.timestamp || item.taken_at_timestamp || item.date, reactions: item.reactions ?? item.likesCount ?? item.likes, commentsCount: item.commentsCount ?? item.comments ?? item.comments_count, sourceProvider: 'apify:instagram' }) });
}
module.exports = { createInstagramProvider, ACTOR };
