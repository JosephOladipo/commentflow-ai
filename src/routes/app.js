const express = require('express');
const path = require('node:path');
const { AppError } = require('../utils/posts');
const { installAuth } = require('../services/auth');
// FEATURE/FUNCTION: Protected HTTP application. PURPOSE: Keep health public and require the owner for private pages and API usage.
function createApp({ discovery, apifyConfigured, comments, accountStore, openaiConfigured = false, auth }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (auth?.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  const { requireOwner, mutation, paidLimit } = installAuth(app, auth);
  const publicDir = path.join(__dirname, '../../public');
  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.get('/login.js', (_req, res) => res.sendFile(path.join(publicDir, 'login.js')));
  app.get('/styles.css', (_req, res) => res.sendFile(path.join(publicDir, 'styles.css')));
  app.use(requireOwner);
  app.get('/api/config', (_req, res) => res.json({ apifyConfigured: Boolean(apifyConfigured), openaiConfigured: Boolean(openaiConfigured) }));
  // FEATURE/FUNCTION: Saved discovery. PURPOSE: Store permanent post identities and search sessions after an explicit provider request.
  app.post('/api/posts/search', mutation, paidLimit, express.json({ limit: '4kb' }), async (req, res) => {
    const result = await discovery.searchPosts(req.body);
    if (accountStore) {
      const saved = await accountStore.recordSearch(req.session.account, req.body, result.posts);
      const byKey = new Map(saved.map(post => [post.key, post]));
      result.posts = result.posts.map(post => ({ ...post, ...(byKey.get(post.platform + ':' + post.id) || {}) }));
    }
    res.json(result);
  });
  // FEATURE/FUNCTION: Cached reference check. PURPOSE: Detect lost server caches after restart without starting discovery.
  app.get('/api/posts/cache/:searchId', (req, res) => res.json(discovery.cacheStatus(req.params.searchId)));
  app.post('/api/comments/generate', mutation, paidLimit, express.json({ limit: '96kb' }), async (req, res) => {
    if (!comments) throw new AppError(503, 'OPENAI_NOT_CONFIGURED', 'Comment generation is not configured.');
    const result = await comments.generate(req.body);
    if (accountStore && req.body.mode === 'manual' && result.posts?.length) await accountStore.upsertManual(req.session.account, result.posts);
    if (accountStore && result.meta.source === 'fresh') await accountStore.recordComments(req.session.account, result.comments, auth.openaiModel);
    res.json(result);
  });
  // FEATURE/FUNCTION: History APIs. PURPOSE: Read permanent owner data without triggering Apify or OpenAI.
  app.get('/api/saved-posts', (req, res) => res.json(accountStore ? accountStore.saved(req.session.account, req.query) : []));
  app.get('/api/search-history', (req, res) => res.json(accountStore ? accountStore.searches(req.session.account) : []));
  app.get('/api/search-history/:id', (req, res) => res.json(accountStore.search(req.session.account, req.params.id)));
  app.get('/api/dashboard', (req, res) => res.json(accountStore ? accountStore.analytics(req.session.account) : {}));
  app.get('/api/settings', (req, res) => res.json(accountStore ? accountStore.settings(req.session.account) : { dailyGoal: 20 }));
  app.post('/api/settings', mutation, express.json({ limit: '2kb' }), async (req, res) => res.json(await accountStore.settings(req.session.account, req.body)));
  app.post('/api/posts/:key/viewed', mutation, express.json({ limit: '1kb' }), async (req, res) => res.json(await accountStore.markViewed(req.session.account, req.params.key)));
  app.post('/api/posts/:key/commented', mutation, express.json({ limit: '1kb' }), async (req, res) => res.json(await accountStore.markCommented(req.session.account, req.params.key, req.body?.commented !== false)));
  app.use(express.static(publicDir, { dotfiles: 'deny' }));
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'This resource was not found.')));
  // FEATURE/FUNCTION: Safe errors. PURPOSE: Keep credentials, stack traces and provider details out of responses.
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') error = new AppError(400, 'INVALID_JSON', 'The request contains invalid JSON.');
    if (error.type === 'entity.too.large') error = new AppError(413, 'BODY_TOO_LARGE', 'The request is too large.');
    const safe = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  });
  return app;
}
module.exports = { createApp };
