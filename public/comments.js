'use strict';
// FEATURE/FUNCTION: Comment workspace. PURPOSE: Keep drafting and manual publishing separate from discovery.
window.CommentFlow = (() => {
  const el = id => document.getElementById(id);
  const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { status('Browser storage is unavailable; edits last only for this session.'); } };
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const drafts = object(load('cf.drafts', {})), storedCommented = load('cf.commented', []);
  const commented = new Set(Array.isArray(storedCommented) ? storedCommented : []);
  let state = { posts: [], mode: 'linkedin', platform: 'linkedin', searchId: null };
  let render = () => {}, generating = false, searching = false, epoch = 0, expiryTimer;
  const unavailableMessage = 'Saved posts remain viewable. Generating comments or alternatives requires an explicit new search. Editing, copying, opening links and tracking still work.';
  const available = () => Workspace.availability(state).available;
  const identity = post => post.platform + ':' + post.id;
  const settings = () => ({ name: el('brand-name').value, description: el('brand-description').value, tone: el('comment-tone').value, style: el('comment-style').value });
  const settingsKey = () => JSON.stringify(settings());
  const remember = () => save('cf.workspace', state);
  const draftFor = post => drafts[identity(post)] || {};
  const manualMode = () => el('platform-select').value === 'x' || el('manual-toggle').checked;
  function status(message, error = false) { el('comment-status').textContent = message; el('comment-status').className = error ? 'error' : ''; }
  // FEATURE/FUNCTION: Submission lock. PURPOSE: Block duplicate paid actions and context changes while requests run.
  function syncControls() {
    for (const control of document.querySelectorAll('main input, main select, main button, main textarea')) control.disabled = generating || searching;
    el('generate-comments').disabled = generating || searching || !state.posts.length || !available();
    for (const button of document.querySelectorAll('[data-generation]')) button.disabled = generating || searching || !available();
    el('workspace-notice').textContent = state.posts.length && !available() ? unavailableMessage : '';
    el('delete-niche').disabled = generating || searching || !el('saved-niches').value;
    for (const button of document.querySelectorAll('[data-empty-copy="true"]')) button.disabled = true;
  }
  function refresh() { render(state.posts); syncControls(); }
  // FEATURE/FUNCTION: Real expiry handling. PURPOSE: Disable generation as the stored server deadline passes, without refreshing its timestamp.
  function watchExpiry() {
    clearTimeout(expiryTimer);
    const remaining = Date.parse(state.expiresAt) - Date.now();
    if (state.mode === 'linkedin' && remaining > 0) expiryTimer = setTimeout(syncControls, Math.min(remaining + 20, 2147483647));
    syncControls();
  }
  async function verifyRestoredSearch() {
    if (state.mode !== 'linkedin' || !/^[a-f0-9]{64}$/.test(state.searchId || '') || Workspace.availability(state).reason === 'expired') return;
    const version = epoch;
    try {
      const response = await Auth.request('/api/posts/cache/' + state.searchId, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (version !== epoch) return;
      if (!response.ok) {
        if (['SEARCH_CACHE_UNAVAILABLE', 'INVALID_SEARCH_REFERENCE'].includes(data.error?.code)) { state.cacheUnavailable = true; remember(); syncControls(); }
        else status('Could not verify the saved search. Refresh after signing in; no paid request was made.', true);
        return;
      }
      state.expiresAt = data.expiresAt; state.cacheUnavailable = false; remember(); watchExpiry();
    } catch { if (version === epoch) status('Could not verify the saved search. No paid request was made.', true); }
  }
  const savedSettings = object(load('cf.brand', {}));
  for (const [id, key] of [['brand-name', 'name'], ['brand-description', 'description'], ['comment-tone', 'tone'], ['comment-style', 'style']]) {
    if (typeof savedSettings[key] === 'string' && (el(id).tagName !== 'SELECT' || [...el(id).options].some(option => option.value === savedSettings[key]))) el(id).value = savedSettings[key];
    el(id).addEventListener('input', () => { epoch++; save('cf.brand', settings()); status('Settings saved. Generate Comments applies them without repeating discovery.'); });
  }
  // FEATURE/FUNCTION: Platform mode. PURPOSE: Restrict discovery to LinkedIn and support pasted posts on all four platforms.
  function updateMode() {
    const names = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
    el('platform-label').textContent = names[el('platform-select').value] + (manualMode() ? ' · Manual input' : ' · Public posts');
    el('manual-toggle-label').hidden = !['linkedin', 'facebook', 'instagram'].includes(el('platform-select').value);
    el('search-form').hidden = manualMode(); el('manual-form').hidden = !manualMode();
    el('manual-form').querySelector('.search-note').textContent = el('platform-select').value === 'linkedin'
      ? 'Paste post text and link for manual assistance. No discovery will run.'
      : 'Paste post text and link. Automatic discovery is not available for this platform yet.';
  }
  function changeContext() {
    epoch++; state = { posts: [], platform: el('platform-select').value, mode: manualMode() ? 'manual' : 'linkedin', searchId: null };
    remember(); updateMode(); refresh(); el('source-badge').hidden = true; el('result-count').hidden = true;
    el('search-status').textContent = manualMode() ? 'Paste a post to prepare a comment.' : 'Choose a niche and find posts.'; status('');
  }
  el('platform-select').addEventListener('change', changeContext);
  el('manual-toggle').addEventListener('change', changeContext);
  for (const id of ['manual-text', 'manual-url', 'keywords', 'time-range', 'quantity', 'sort', 'search-mode', 'match-mode']) el(id).addEventListener('input', () => { epoch++; });
  el('show-commented').checked = load('cf.showCommented', false) === true;
  el('show-commented').addEventListener('change', () => { save('cf.showCommented', el('show-commented').checked); refresh(); });
  // FEATURE/FUNCTION: Comment transport. PURPOSE: Send one bounded request and never retry automatically.
  async function request(body) {
    const response = await Auth.request('/api/comments/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
    const data = await response.json(); if (!response.ok) { const error = new Error(data.error?.message || 'Comment generation failed.'); error.code = data.error?.code; throw error; } return data;
  }
  function storeComments(data, capturedSettings, alternative = false) {
    for (const comment of data.comments) {
      const post = state.posts.find(post => post.id === comment.postId && post.platform === comment.platform);
      if (!post) continue;
      const key = identity(post);
      // Normal regeneration preserves user edits; an explicit alternative replaces its previous draft.
      if (drafts[key]?.edited && !alternative) continue;
      drafts[key] = { comment: comment.comment, suitable: comment.suitable, relevanceReason: comment.relevanceReason, settingsKey: capturedSettings, edited: false };
    }
    save('cf.drafts', drafts);
  }
  // FEATURE/FUNCTION: Saved comment reuse. PURPOSE: Show durable prior suggestions without requesting the AI again.
  function restoreSavedComments(posts) {
    for (const post of posts) {
      const history = Array.isArray(post.commentHistory) ? post.commentHistory : [];
      const prior = history.at(-1);
      if (prior?.commentText && !draftFor(post).comment) drafts[identity(post)] = { comment: prior.commentText, suitable: true, relevanceReason: 'Previously generated comment.', edited: false };
    }
    save('cf.drafts', drafts);
  }
  // FEATURE/FUNCTION: Batch and alternative generation. PURPOSE: Reuse server-owned LinkedIn text without rerunning Apify.
  async function generate(posts, alternative = false) {
    if (generating) return;
    if (!available()) { syncControls(); status(unavailableMessage, true); return; }
    posts = posts.filter(post => !commented.has(identity(post)) && !(Array.isArray(post.commentHistory) && post.commentHistory.length));
    if (!posts.length) { status('Existing saved comments are shown where available. No new AI request was needed.'); return; }
    generating = true; const version = epoch, capturedSettings = settingsKey();
    syncControls(); status(alternative ? 'Generating one alternative…' : 'Generating comments in one batch…');
    const body = { mode: state.mode, settings: settings(), alternative };
    if (['linkedin', 'facebook', 'instagram'].includes(state.mode)) { body.searchId = state.searchId; body.postIds = posts.map(post => post.id); }
    else body.manual = { platform: posts[0].platform, postUrl: posts[0].postUrl, postText: posts[0].postText };
    if (alternative) body.previousDraft = draftFor(posts[0]).comment || '';
    try {
      const data = await request(body); if (version !== epoch) return;
      storeComments(data, capturedSettings, alternative);
      status((data.meta.source === 'cache' ? 'Comments reused from cache.' : 'Comments ready.') + ' Review before copying; relevance screening is not fact-checking. Saved edits are preserved unless you request an alternative. ' + (data.warning || ''));
      el('generate-comments').textContent = 'Generate Comments'; refresh();
    } catch (error) {
      if (version === epoch) { if (['SEARCH_CACHE_UNAVAILABLE', 'INVALID_POST_SELECTION', 'UNKNOWN_POST_ID'].includes(error.code)) { state.cacheUnavailable = true; remember(); }
        status((error.name === 'TimeoutError' || error instanceof TypeError ? 'Connection interrupted. No automatic retry was made.' : error.message) + ' Posts and existing drafts are retained.', true); el('generate-comments').textContent = 'Retry Comments'; }
    } finally { generating = false; syncControls(); }
  }
  el('generate-comments').addEventListener('click', () => generate(state.posts));
  el('manual-form').addEventListener('submit', async event => {
    event.preventDefault(); if (generating || searching) return;
    generating = true; const version = epoch, capturedSettings = settingsKey(); syncControls(); status('Generating one manual comment…');
    try {
      const data = await request({ mode: 'manual', settings: settings(), manual: { platform: el('platform-select').value, postText: el('manual-text').value, postUrl: el('manual-url').value } });
      if (version !== epoch) return;
      state = { mode: 'manual', platform: data.posts[0].platform, searchId: null, posts: data.posts };
      storeComments(data, capturedSettings); remember(); refresh();
      el('search-status').textContent = 'Manual post · supplied text only. No source URL was fetched.';
      el('source-badge').hidden = true; el('result-count').textContent = '1'; el('result-count').hidden = false;
      status((data.meta.source === 'cache' ? 'Cached comment ready.' : 'Comment ready.') + ' Review before copying. ' + (data.warning || ''));
    } catch (error) { if (version === epoch) status(error.name === 'TimeoutError' || error instanceof TypeError ? 'Comment request interrupted. No automatic retry was made.' : error.message, true); }
    finally { generating = false; syncControls(); }
  });
  // FEATURE/FUNCTION: Editable comment card. PURPOSE: Keep copy, open, reviewed and commented controls independent.
  function decorateCard(card, post) {
    const key = identity(post), draft = draftFor(post);
    const area = document.createElement('section'); area.className = 'comment-composer';
    const label = document.createElement('label'); label.textContent = 'Your comment';
    const textarea = document.createElement('textarea'); textarea.rows = 3; textarea.maxLength = post.platform === 'x' ? 280 : 1500;
    textarea.id = 'draft-' + key; label.htmlFor = textarea.id; textarea.value = typeof draft.comment === 'string' ? draft.comment : '';
    textarea.placeholder = draft.suitable === false ? 'This post was marked unsuitable. Review the reason below.' : 'Generate a suggestion, or write your own comment.';
    const reason = document.createElement('p'); reason.className = 'comment-reason';
    reason.textContent = (draft.suitable === false ? 'Unsuitable: ' : '') + (draft.relevanceReason || 'Review the post before drafting your response.');
    const feedback = document.createElement('span'); feedback.className = 'copy-feedback'; feedback.setAttribute('role', 'status');
    const counter = document.createElement('span'); counter.className = 'comment-counter';
    const actions = document.createElement('div'); actions.className = 'post-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.textContent = 'Copy Comment';
    const alternative = document.createElement('button'); alternative.type = 'button'; alternative.className = 'text-button'; alternative.textContent = draft.comment ? 'Generate Alternative' : 'Generate Comment'; alternative.dataset.generation = 'true';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'review-button';
    const isCommented = commented.has(key); card.classList.toggle('commented', isCommented);
    done.textContent = isCommented ? '✓ Commented · Undo' : 'Mark as Commented'; done.setAttribute('aria-pressed', String(isCommented));
    const update = () => { const valid = Boolean(textarea.value.trim()) && (post.platform !== 'x' || textarea.value.length <= 280);
      copy.dataset.emptyCopy = String(!valid); copy.disabled = !valid || generating || searching;
      alternative.textContent = textarea.value.trim() ? 'Generate Alternative' : 'Generate Comment'; alternative.disabled = generating || searching || !available();
      counter.textContent = post.platform === 'x' ? textarea.value.length + '/280 characters' : textarea.value.trim().split(/\s+/).filter(Boolean).length + ' words'; };
    textarea.addEventListener('input', () => { drafts[key] = { ...draftFor(post), comment: textarea.value, edited: true }; save('cf.drafts', drafts); update(); feedback.textContent = 'Edit saved.'; });
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(textarea.value); feedback.textContent = 'Copied. Open the post and paste manually.'; }
      catch { textarea.focus(); textarea.select(); feedback.textContent = 'Clipboard unavailable. Text selected — press Ctrl+C (or copy manually).'; } });
    alternative.addEventListener('click', () => generate([post], Boolean(textarea.value.trim())));
    done.addEventListener('click', async () => {
      const next = !commented.has(key);
      if (next) commented.add(key); else commented.delete(key);
      save('cf.commented', [...commented]); refresh();
      try { await Auth.request('/api/posts/' + encodeURIComponent(key) + '/commented', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commented: next }) }); }
      catch { status('Comment status was saved in this browser but could not be recorded on the server.', true); }
    });
    actions.append(copy, alternative, done, counter); area.append(label, textarea, reason, actions, feedback); card.append(area); update();
  }
  return {
    isBusy: () => generating || searching,
    beginSearch() { searching = true; epoch++; syncControls(); return epoch; },
    endSearch() { searching = false; syncControls(); },
    acceptSearch(posts, meta, version, platform = 'linkedin') { if (version !== epoch) return false; restoreSavedComments(posts); state = { posts, searchId: meta.searchId, expiresAt: meta.expiresAt, platform, mode: platform, cacheUnavailable: false }; remember(); watchExpiry(); return true; },
    visiblePosts: posts => posts.filter(post => el('show-commented').checked || !commented.has(identity(post))),
    generateDisplayed: () => generate(state.posts), decorateCard,
    // FEATURE/FUNCTION: Session restoration. PURPOSE: Restore cards and edits without any paid request.
    restore(renderer) {
      render = renderer; const saved = object(load('cf.workspace', {}));
      if (['linkedin', 'manual'].includes(saved.mode) && ['linkedin', 'facebook', 'instagram', 'x'].includes(saved.platform) && Array.isArray(saved.posts)) {
        const hosts = ['linkedin.com', 'www.linkedin.com', 'facebook.com', 'www.facebook.com', 'instagram.com', 'www.instagram.com', 'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'];
        const posts = saved.posts.slice(0, 10).filter(post => { try { const url = new URL(post.postUrl); return post.platform === saved.platform && typeof post.id === 'string' && typeof post.postText === 'string' && url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port; } catch { return false; } });
        state = { ...saved, posts }; el('platform-select').value = state.platform; el('manual-toggle').checked = state.mode === 'manual';
        if (state.mode === 'manual' && posts[0]) { el('manual-text').value = posts[0].postText; el('manual-url').value = posts[0].postUrl; }
        if (posts.length) { refresh(); el('search-status').textContent = 'Restored posts and drafts. No discovery was run. Cached LinkedIn text must still be available to generate comments.'; }
      }
      updateMode(); watchExpiry(); void verifyRestoredSearch();
    },
  };
})();
