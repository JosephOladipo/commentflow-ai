const { createPublicProvider } = require('./apify-public');
const ACTOR = 'data-slayer~facebook-post-search';
function createFacebookProvider({ token, actor = ACTOR, fetchImpl }) {
  return createPublicProvider({ token, actor, platform: 'facebook', fetchImpl,
    inputFor: query => ({ search_query: query.expression, query: query.expression, max_posts: query.limit, resultsLimit: query.limit }),
    map: item => ({ id: String(item.postId || item.post_id || item.id || ''), platform: 'facebook', authorName: item.authorName || item.author?.name || item.pageName || item.user_name,
      authorHeadline: item.authorHeadline || item.author?.headline, authorProfileUrl: item.authorProfileUrl || item.author?.url || item.profileUrl,
      postText: item.text || item.message || item.caption, postUrl: item.postUrl || item.post_url || item.url || item.permalink,
      publishedAt: item.publishedAt || item.created_time || item.timestamp || item.date, reactions: item.reactions ?? item.likesCount ?? item.likes, commentsCount: item.commentsCount ?? item.comments ?? item.comments_count, sourceProvider: 'apify:facebook' }) });
}
module.exports = { createFacebookProvider, ACTOR };
