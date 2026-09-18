'use strict';
const $ = id => document.getElementById(id);
const initialNiches = ['AI automation', 'Social media marketing', 'Marketing operations', 'Business process automation', 'Remote work and productivity'];
// FEATURE/FUNCTION: Local preferences. PURPOSE: Keep saved niches and review history in this browser.
function readStored(key, fallback) {
  try { const data = JSON.parse(localStorage.getItem(key)); return data ?? fallback; } catch { return fallback; }
}
function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { $('niche-status').textContent = 'Browser storage is unavailable; changes last only for this session.'; return false; }
}
const storedNiches = readStored('cf.niches', initialNiches);
let niches = Array.isArray(storedNiches) ? storedNiches.filter(x => typeof x === 'string' && x.length <= 150).slice(0, 100) : [...initialNiches];
const storedReviewed = readStored('cf.reviewed', []);
const reviewed = new Set(Array.isArray(storedReviewed) ? storedReviewed.filter(x => typeof x === 'string') : []);
let busy = false;
// FEATURE/FUNCTION: Safe DOM construction. PURPOSE: Treat provider and operator content as text, never executable HTML.
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function renderNiches(selected = '') {
  $('saved-niches').replaceChildren(new Option('Choose a saved niche', ''), ...niches.map(niche => new Option(niche, niche)));
  $('saved-niches').value = selected;
  $('delete-niche').disabled = !selected;
}
renderNiches();
const preferences = readStored('cf.preferences', {});
for (const [id, key] of [['time-range', 'timeRange'], ['quantity', 'limit'], ['sort', 'sortBy']]) {
  if ([...$(id).options].some(option => option.value === String(preferences?.[key]))) $(id).value = String(preferences[key]);
}
$('saved-niches').addEventListener('change', () => {
  const value = $('saved-niches').value;
  if (value) $('keywords').value = value;
  $('delete-niche').disabled = !value; $('niche-status').textContent = '';
});
$('save-niche').addEventListener('click', () => {
  const niche = $('keywords').value.trim().replace(/\s+/g, ' ');
  if (niche.length < 2 || niche.length > 150 || !/[\p{L}\p{N}]{2}/u.test(niche)) { $('niche-status').textContent = 'Enter a meaningful niche first (2–150 characters).'; return; }
  const existing = niches.find(x => x.toLowerCase() === niche.toLowerCase());
  if (!existing && niches.length >= 100) { $('niche-status').textContent = 'You can save up to 100 niches.'; return; }
  if (!existing) niches.push(niche);
  $('niche-status').textContent = existing ? 'Niche already saved.' : 'Niche saved.';
  saveStored('cf.niches', niches); renderNiches(existing || niche);
});
$('delete-niche').addEventListener('click', () => {
  niches = niches.filter(niche => niche !== $('saved-niches').value);
  $('niche-status').textContent = 'Niche deleted.'; saveStored('cf.niches', niches); renderNiches();
});
// FEATURE/FUNCTION: Result cards. PURPOSE: Present genuine context with explicit source and review actions.
function renderPosts(posts) {
  posts = CommentFlow.visiblePosts(posts);
  $('results').replaceChildren();
  if (!posts.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('div', 'empty-icon', '⌕'), element('h3', '', 'No usable posts in this search.'),
      element('p', '', 'No visible opportunities. Enable Show commented posts if you have already commented on these posts, or choose another search.'));
    $('results').append(empty); return;
  }
  for (const post of posts) {
    const card = element('article', 'post-card');
    const header = element('div', 'post-header'), author = element('div');
    author.append(element('h3', 'post-author', post.authorName || 'Author unavailable'));
    if (post.authorHeadline) author.append(element('p', 'post-headline', post.authorHeadline));
    const date = post.publishedAt ? new Date(post.publishedAt) : null;
    const time = element('time', 'post-time', date ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Manual input');
    if (date) { time.dateTime = post.publishedAt; time.title = date.toLocaleString(); }
    header.append(element('div', 'avatar', (post.authorName || '?').split(' ').slice(0, 2).map(part => part[0]).join('').toUpperCase()), author, time);
    const body = element('p', 'post-body collapsed', post.postText);
    card.append(header, body);
    if (post.postText.length > 300 || post.postText.split('\n').length > 5) {
      const more = element('button', 'text-button', 'Read full post');
      more.type = 'button'; more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => { const collapsed = body.classList.toggle('collapsed'); more.textContent = collapsed ? 'Read full post' : 'Show less'; more.setAttribute('aria-expanded', String(!collapsed)); });
      card.append(more);
    }
    const stats = [];
    if (post.reactions !== null) stats.push(post.reactions.toLocaleString() + ' reactions');
    if (post.commentsCount !== null) stats.push(post.commentsCount.toLocaleString() + ' comments');
    if (stats.length) card.append(element('p', 'engagement', stats.join('  ·  ')));
    const actions = element('div', 'post-actions'), link = element('a', '', 'Open Post ↗');
    link.href = post.postUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const review = element('button', 'review-button'); review.type = 'button';
    const updateReview = () => { const done = reviewed.has(post.postUrl); card.classList.toggle('reviewed', done); review.textContent = done ? '✓ Reviewed · Undo' : 'Mark as Reviewed'; review.setAttribute('aria-pressed', String(done)); };
    review.addEventListener('click', () => { if (reviewed.has(post.postUrl)) reviewed.delete(post.postUrl); else reviewed.add(post.postUrl); saveStored('cf.reviewed', [...reviewed]); updateReview(); });
    updateReview(); actions.append(link, review);
    card.append(actions);
    CommentFlow.decorateCard(card, post);
    $('results').append(card);
  }
}
// FEATURE/FUNCTION: Explicit search. PURPOSE: Send one request per submission with clear loading and error states.
$('search-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || CommentFlow.isBusy()) return;
  busy = true;
  const context = CommentFlow.beginSearch();
  const includeAI = $('include-comments').checked;
  const query = { platform: 'linkedin', keywords: $('keywords').value, timeRange: $('time-range').value, limit: Number($('quantity').value), sortBy: $('sort').value };
  saveStored('cf.preferences', query);
  const controls = [...$('search-form').querySelectorAll('input, select, button')];
  controls.forEach(control => control.disabled = true);
  $('find-posts').textContent = 'Finding posts…'; $('find-posts').classList.add('loading');
  $('results').replaceChildren(); $('results').setAttribute('aria-busy', 'true');
  $('source-badge').hidden = true; $('result-count').hidden = true;
  $('search-status').className = ''; $('search-status').textContent = 'Searching LinkedIn via Apify. This can take up to two minutes. Keep this page open.';
  try {
    const response = await Auth.request('/api/posts/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(155000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Search failed.');
    if (!await Workspace.finishSearch(data, context, includeAI, { acceptSearch: CommentFlow.acceptSearch, renderPosts, generateDisplayed: CommentFlow.generateDisplayed })) return;
    $('source-badge').textContent = data.meta.source === 'cache' ? 'CACHED · NO NEW RUN' : 'FRESH · APIFY';
    $('source-badge').hidden = false; $('result-count').textContent = data.meta.count; $('result-count').hidden = false;
    $('search-status').textContent = Workspace.describeSearch(data.meta) + '\n' +
      (data.meta.source === 'cache' ? 'Cached search from ' + new Date(data.meta.searchedAt).toLocaleString() + '.' : 'Search complete.') + ' ' + (data.warning || '');
  } catch (error) {
    $('search-status').className = 'error';
    $('search-status').textContent = error.name === 'TimeoutError' || error instanceof TypeError
      ? 'Connection interrupted. A provider run may have started. Check Apify Console before searching again; no automatic retry was made.' : error.message;
  } finally {
    busy = false; controls.forEach(control => control.disabled = false);
    $('delete-niche').disabled = !$('saved-niches').value;
    $('find-posts').textContent = 'Find Posts'; $('find-posts').classList.remove('loading'); $('results').setAttribute('aria-busy', 'false');
    CommentFlow.endSearch();
  }
});
// FEATURE/FUNCTION: Read-only health check. PURPOSE: Show setup status without running Apify on page load.
Auth.request('/api/config', { signal: AbortSignal.timeout(5000) }).then(response => {
  if (!response.ok) throw new Error('Health unavailable'); return response.json();
}).then(health => {
  $('connection').textContent = (health.apifyConfigured ? 'Apify ready' : 'Apify setup needed') + ' · ' + (health.openaiConfigured ? 'OpenAI ready' : 'OpenAI setup needed');
  $('connection').classList.add(health.apifyConfigured ? 'ready' : 'missing');
  if (!health.apifyConfigured) $('search-status').textContent = 'Setup: add APIFY_API_TOKEN to your local .env file and restart the server. Your token stays on the server.';
}).catch(() => { $('connection').textContent = '○ Server unavailable'; });

CommentFlow.restore(renderPosts);
