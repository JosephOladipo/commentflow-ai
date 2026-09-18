const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const { rateLimit } = require('express-rate-limit');
const { randomBytes, scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { AppError } = require('../utils/posts');
const derive = promisify(scrypt);
const SESSION_MS = 8 * 60 * 60 * 1000;
// FEATURE/FUNCTION: Password verification. PURPOSE: Compare salted scrypt hashes without storing plaintext passwords.
async function verifyPassword(password, encoded) {
  const [, salt, expected] = encoded.split('$');
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function safeEqual(a, b) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
// FEATURE/FUNCTION: Single-owner authentication. PURPOSE: Protect private assets and API spending using revocable server-side sessions.
function installAuth(app, config) {
  if (!config?.username || !config.passwordHash || !config.sessionSecret) throw new Error('Authentication configuration is required.');
  app.set('trust proxy', config.proxyHops || false);
  const cookieName = config.production ? '__Host-commentflow.sid' : 'commentflow.sid';
  const cookie = { httpOnly: true, secure: config.production || config.publicOrigin?.startsWith('https:'), sameSite: 'strict', path: '/', maxAge: SESSION_MS };
  const store = new MemoryStore({ checkPeriod: 60000, max: 1000 });
  app.locals.sessionStore = store;
  // FEATURE/FUNCTION: Host/transport checks. PURPOSE: Accept only the configured HTTPS origin online and loopback hosts locally.
  app.use((req, _res, next) => {
    const expectedHost = config.publicOrigin ? new URL(config.publicOrigin).host : null;
    if (expectedHost ? req.get('host') !== expectedHost : !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname))
      return next(new AppError(403, 'HOST_REJECTED', 'Use the configured application address.'));
    if (config.production && !req.secure) return next(new AppError(403, 'HTTPS_REQUIRED', 'HTTPS is required.'));
    next();
  });
  app.use(session({ name: cookieName, secret: config.sessionSecret, store, resave: false, saveUninitialized: false, rolling: false, cookie }));
  const limited = (limit, windowMs, message, extra = {}) => rateLimit({ limit, windowMs, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }), ...extra });
  const loginLimit = limited(5, 15 * 60000, 'Too many login attempts. Wait 15 minutes before trying again.');
  const ownerLimit = limited(20, 15 * 60000, 'Login is temporarily limited. Wait 15 minutes.', { keyGenerator: () => 'single-owner' });
  const bootstrapLimit = limited(60, 60000, 'Too many session requests. Please wait.');
  const paidLimit = limited(12, 60000, 'Too many paid requests. Wait one minute before trying again.', { keyGenerator: req => req.sessionID });
  // FEATURE/FUNCTION: CSRF validation. PURPOSE: Require a session-bound token and same-origin mutations.
  function mutation(req, _res, next) {
    const origin = req.get('origin');
    const expectedOrigin = config.publicOrigin || 'http://' + req.get('host');
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin))
      return next(new AppError(403, 'ORIGIN_REJECTED', 'Requests must come from this dashboard.'));
    const token = req.get('x-csrf-token');
    if (!token || !req.session?.csrf || !safeEqual(token, req.session.csrf)) return next(new AppError(403, 'CSRF_REJECTED', 'Refresh the page and try again.'));
    if (!req.is('application/json')) return next(new AppError(415, 'JSON_REQUIRED', 'Send application/json.'));
    next();
  }
  function requireOwner(req, res, next) {
    if (!req.session?.owner || !req.session.authenticatedAt || Date.now() - req.session.authenticatedAt >= SESSION_MS) {
      if (req.path.startsWith('/api/')) return next(new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue. Your saved drafts remain in this browser.'));
      return res.redirect(303, '/login');
    }
    next();
  }
  app.get('/api/auth/session', bootstrapLimit, (req, res) => {
    req.session.csrf ||= randomBytes(32).toString('hex');
    res.json({ authenticated: Boolean(req.session.owner && Date.now() - req.session.authenticatedAt < SESSION_MS), csrfToken: req.session.csrf });
  });
  app.post('/api/auth/login', loginLimit, ownerLimit, mutation, require('express').json({ limit: '2kb' }), async (req, res, next) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || password.length < 1 || password.length > 1024)
      throw new AppError(400, 'INVALID_LOGIN', 'Enter your owner username and password.');
    const validPassword = await verifyPassword(password, config.passwordHash);
    if (!safeEqual(username, config.username) || !validPassword) throw new AppError(401, 'INVALID_LOGIN', 'Incorrect username or password.');
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.owner = true; req.session.authenticatedAt = Date.now(); req.session.csrf = randomBytes(32).toString('hex');
      req.session.save(error => error ? next(error) : res.json({ authenticated: true, csrfToken: req.session.csrf }));
    });
  });
  app.post('/api/auth/logout', requireOwner, mutation, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie(cookieName, { path: '/', httpOnly: true, secure: cookie.secure, sameSite: 'strict' });
      res.json({ loggedOut: true });
    });
  });
  return { requireOwner, mutation, paidLimit };
}
module.exports = { installAuth, verifyPassword };
