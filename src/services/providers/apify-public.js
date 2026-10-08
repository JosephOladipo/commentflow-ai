const { AppError, validateSearch } = require('../../utils/posts');
// FEATURE/FUNCTION: Bounded public actor call. PURPOSE: Share no-retry, timeout, and spend limits across non-LinkedIn adapters.
function createPublicProvider({ token, actor, platform, inputFor, map, fetchImpl = fetch }) {
  return { async searchPosts(search) {
    const query = validateSearch(search);
    if (!token) throw new AppError(503, 'APIFY_NOT_CONFIGURED', `${platform} discovery is not configured. Add APIFY_API_TOKEN and restart.`);
    try {
      const url = new URL(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`);
      url.searchParams.set('timeout', '120'); url.searchParams.set('restartOnError', 'false'); url.searchParams.set('maxItems', String(query.limit)); url.searchParams.set('limit', String(query.limit)); url.searchParams.set('maxTotalChargeUsd', '0.05');
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(inputFor({ ...query, expression: search.providerKeywords || query.keywords })), signal: AbortSignal.timeout(140000) });
      if (!response.ok) throw new AppError(502, `${platform.toUpperCase()}_REQUEST_FAILED`, `${platform} discovery is temporarily unavailable. LinkedIn and saved results are still available.`);
      const data = await response.json(); if (!Array.isArray(data)) throw new AppError(502, `${platform.toUpperCase()}_OUTPUT_CHANGED`, `${platform} returned an unexpected result format. Check the actor output before trying again.`);
      return data.slice(0, query.limit).map(item => map(item)).filter(Boolean);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, `${platform.toUpperCase()}_CONNECTION_FAILED`, `${platform} discovery is temporarily unavailable. LinkedIn and saved results are still available.`);
    }
  } };
}
module.exports = { createPublicProvider };
