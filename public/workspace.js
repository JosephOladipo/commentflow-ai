// FEATURE/FUNCTION: Workspace presentation rules. PURPOSE: Share tested exclusion and cache-reference logic with the browser.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Workspace = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function describeSearch(meta) {
    const labels = { outsideRange: 'outside the selected time window or future-dated', timestamp: 'missing a reliable timestamp',
      invalid: 'invalid content or an unsupported source link', duplicate: 'duplicate posts', agedOut: 'cached posts that have since left the selected time window' };
    const lines = [meta.count + ' usable posts · up to ' + meta.requested + ' candidates requested'];
    for (const [key, label] of Object.entries(labels)) {
      const count = key === 'agedOut' ? meta.agedOut : meta.excluded?.[key];
      if (Number.isInteger(count) && count > 0) lines.push(count + ' excluded: ' + label + '.');
    }
    return lines.join('\n');
  }
  function availability(state, now = Date.now()) {
    if (!['linkedin', 'facebook', 'instagram'].includes(state.mode)) return { available: true };
    if (state.cacheUnavailable || typeof state.searchId !== 'string' || !/^[a-f0-9]{64}$/.test(state.searchId))
      return { available: false, reason: 'missing' };
    const expiry = Date.parse(state.expiresAt);
    if (!Number.isFinite(expiry)) return { available: false, reason: 'unverified' };
    return expiry <= now ? { available: false, reason: 'expired' } : { available: true };
  }
  // FEATURE/FUNCTION: Explicit search completion. PURPOSE: Preserve one automatic first-comment batch after a successful user search.
  async function finishSearch(data, context, includeAI, ui) {
    if (!ui.acceptSearch(data.posts, data.meta, context)) return false;
    ui.renderPosts(data.posts);
    if (includeAI) await ui.generateDisplayed();
    return true;
  }
  return { describeSearch, availability, finishSearch };
});
