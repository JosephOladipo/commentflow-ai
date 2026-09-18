const { createHash } = require('node:crypto');
const { AppError, linkedinUrl } = require('./posts');
const hash = value => createHash('sha256').update(value).digest('hex');
const tones = ['professional', 'friendly', 'conversational'];
const styles = ['supportive insight', 'useful addition', 'thoughtful question', 'short response'];
// FEATURE/FUNCTION: Brand validation. PURPOSE: Bound one operator's context without assuming achievements.
function validateSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_SETTINGS', 'Provide brand settings.');
  const { name = '', description = '', tone = 'professional', style = 'useful addition' } = value;
  if (typeof name !== 'string' || name.length > 100 || typeof description !== 'string' || description.length > 1000 || !tones.includes(tone) || !styles.includes(style))
    throw new AppError(400, 'INVALID_SETTINGS', 'Use a brand name up to 100 characters, description up to 1,000, and an available tone and style.');
  return { name: name.trim(), description: description.trim(), tone, style };
}
// FEATURE/FUNCTION: Manual source validation. PURPOSE: Accept recognisable post URLs without fetching or following them.
function manualUrl(platform, value) {
  if (platform === 'linkedin') return linkedinUrl(value);
  try {
    const url = new URL(value);
    const hosts = { facebook: ['facebook.com', 'www.facebook.com'], instagram: ['instagram.com', 'www.instagram.com'],
      x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'] };
    if (!hosts[platform]?.includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (platform === 'instagram' && /^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
      return 'https://www.instagram.com' + url.pathname.replace(/\/$/, '');
    if (platform === 'x' && /^\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}\/?$/.test(url.pathname))
      return 'https://x.com' + url.pathname.replace(/\/$/, '');
    if (platform === 'facebook') {
      if (/^\/(?:[^/]+\/posts\/[A-Za-z0-9_.-]+|groups\/[^/]+\/(?:posts|permalink)\/\d+|reel\/\d+|[^/]+\/videos\/\d+)\/?$/.test(url.pathname))
        return 'https://www.facebook.com' + url.pathname.replace(/\/$/, '');
      if (['/permalink.php', '/story.php'].includes(url.pathname) && /^[A-Za-z0-9]+$/.test(url.searchParams.get('story_fbid') || '') && /^\d+$/.test(url.searchParams.get('id') || ''))
        return 'https://www.facebook.com' + url.pathname + '?story_fbid=' + url.searchParams.get('story_fbid') + '&id=' + url.searchParams.get('id');
      if (url.pathname === '/photo.php' && /^\d+$/.test(url.searchParams.get('fbid') || ''))
        return 'https://www.facebook.com/photo.php?fbid=' + url.searchParams.get('fbid');
    }
  } catch { /* Invalid input remains a controlled validation error. */ }
  return null;
}
function validateManual(value) {
  const postUrl = manualUrl(value?.platform, value?.postUrl);
  const text = value?.postText;
  if (!postUrl) throw new AppError(400, 'INVALID_POST_URL', 'Paste an expanded HTTPS post link for the selected platform. Profile links, short links and unrelated domains are not supported.');
  if (typeof text !== 'string' || text.trim().length < 20 || text.length > 15000 || !/[\p{L}\p{N}]{3}/u.test(text))
    throw new AppError(400, 'INVALID_POST_TEXT', 'Paste meaningful post text between 20 and 15,000 characters.');
  const id = value.platform === 'linkedin' ? postUrl.match(/(?:activity-|urn:li:(?:activity|share|ugcPost):)(\d+)/)?.[1] : null;
  return { id: id || hash(value.platform + ':' + postUrl), platform: value.platform, postUrl, postText: text.trim(),
    authorName: null, authorHeadline: null, publishedAt: null, reactions: null, commentsCount: null, sourceProvider: 'manual' };
}
// FEATURE/FUNCTION: Strict model output. PURPOSE: Reject unknown IDs and invalid drafts before mapping to trusted sources.
function validateComments(data, posts) {
  const invalid = () => { throw new AppError(502, 'INVALID_AI_OUTPUT', 'AI returned an invalid or incomplete draft. Your posts are retained; retry comments only if needed.'); };
  if (!data || Object.keys(data).length !== 1 || !Array.isArray(data.comments) || data.comments.length !== posts.length) invalid();
  const ids = new Map(posts.map(post => [post.id, post])), seen = new Set();
  for (const item of data.comments) {
    if (!item || Object.keys(item).sort().join(',') !== 'comment,postId,relevanceReason,suitable' || typeof item.postId !== 'string' || !ids.has(item.postId) || seen.has(item.postId) ||
      typeof item.comment !== 'string' || typeof item.relevanceReason !== 'string' || !item.relevanceReason.trim() || item.relevanceReason.length > 500 || typeof item.suitable !== 'boolean') invalid();
    if (item.comment.length > 1500 || (ids.get(item.postId).platform === 'x' && item.comment.length > 280) ||
      (item.suitable && !item.comment.trim()) || (!item.suitable && item.comment !== '') || /https?:\/\/|www\.|#[\p{L}\p{N}_]/iu.test(item.comment)) invalid();
    seen.add(item.postId);
  }
  return posts.map(post => ({ ...data.comments.find(item => item.postId === post.id), postUrl: post.postUrl, platform: post.platform }));
}
module.exports = { hash, validateSettings, manualUrl, validateManual, validateComments };
