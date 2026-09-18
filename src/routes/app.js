const express = require('express');
const path = require('node:path');
const { AppError } = require('../utils/posts');
const { installAuth } = require('../services/auth');
// FEATURE/FUNCTION: Protected HTTP application. PURPOSE: Keep health public and require the owner for private pages and API usage.
function createApp({ discovery, apifyConfigured, comments, openaiConfigured = false, auth }) {
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
  app.post('/api/posts/search', mutation, paidLimit, express.json({ limit: '4kb' }), async (req, res) => res.json(await discovery.searchPosts(req.body)));
  // FEATURE/FUNCTION: Cached reference check. PURPOSE: Detect lost server caches after restart without starting discovery.
  app.get('/api/posts/cache/:searchId', (req, res) => res.json(discovery.cacheStatus(req.params.searchId)));
  app.post('/api/comments/generate', mutation, paidLimit, express.json({ limit: '96kb' }), async (req, res) => {
    if (!comments) throw new AppError(503, 'OPENAI_NOT_CONFIGURED', 'Comment generation is not configured.');
    res.json(await comments.generate(req.body));
  });
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
