const path = require('node:path');
// FEATURE/FUNCTION: Deployment guards. PURPOSE: Fail closed before listening if single-owner access or hosting settings are unsafe.
function readConfig(env = process.env) {
  const fail = message => { const error = new Error(message); error.code = 'CONFIGURATION_ERROR'; throw error; };
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT must be a valid TCP port.');
  const host = env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
  if (!production && !['127.0.0.1', 'localhost', '::1'].includes(host)) fail('Non-loopback hosting requires production mode and HTTPS.');
  const username = (env.OWNER_USERNAME || '').trim();
  const passwordHash = env.OWNER_PASSWORD_HASH || '';
  const sessionSecret = env.SESSION_SECRET || '';
  if (!username || username.length > 100 || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash))
    fail('Configure OWNER_USERNAME and OWNER_PASSWORD_HASH before starting. Run npm run password-hash to create a password hash.');
  if (!/^[a-f0-9]{96}$/i.test(sessionSecret) || new Set(sessionSecret).size < 8)
    fail('SESSION_SECRET must be a randomly generated 48-byte hexadecimal secret. See README.');
  const proxyHops = Number(env.TRUST_PROXY_HOPS || 0);
  if (![0, 1].includes(proxyHops)) fail('TRUST_PROXY_HOPS must be 0 or 1. Only trust a single hosting proxy that blocks direct access.');
  let publicOrigin = (env.PUBLIC_ORIGIN || '').trim();
  if (production && !publicOrigin) fail('PUBLIC_ORIGIN is required in production.');
  if (publicOrigin) {
    try {
      const url = new URL(publicOrigin);
      if (url.origin !== publicOrigin || url.username || url.password || (production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol))) throw new Error();
    } catch { fail('PUBLIC_ORIGIN must be a complete origin without a path; production requires HTTPS.'); }
  }
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '../../data'));
  return { production, port, host, publicOrigin, proxyHops, username, passwordHash, sessionSecret,
    token: (env.APIFY_API_TOKEN || '').trim(), linkedinActor: (env.APIFY_LINKEDIN_ACTOR || 'apimaestro~linkedin-posts-search-scraper-no-cookies').trim(), facebookActor: (env.APIFY_FACEBOOK_ACTOR || 'data-slayer~facebook-post-search').trim(), instagramActor: (env.APIFY_INSTAGRAM_ACTOR || 'scraping_solutions~instagram-boolean-search-scraper-posts-reels').trim(), openaiKey: (env.OPENAI_API_KEY || '').trim(),
    openaiModel: (env.OPENAI_MODEL || 'gpt-4.1-mini').trim(), dataDir,
    cacheFile: path.join(dataDir, 'search-cache.json'), commentCacheFile: path.join(dataDir, 'comment-cache.json'), accountStoreFile: path.join(dataDir, 'account-history.json') };
}
module.exports = { readConfig };
