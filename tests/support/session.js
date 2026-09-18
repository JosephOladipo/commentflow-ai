const { scryptSync, randomBytes } = require('node:crypto');
const { readConfig } = require('../../src/config/runtime');
// FEATURE/FUNCTION: Offline owner session. PURPOSE: Exercise real authentication with synthetic credentials in HTTP tests.
const password = 'offline-test-password-only';
const salt = '1234567890abcdef1234567890abcdef';
const testEnv = { OWNER_USERNAME: 'test-owner', OWNER_PASSWORD_HASH: 'scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('hex'),
  SESSION_SECRET: randomBytes(48).toString('hex') };
const testAuth = readConfig(testEnv), sessions = new Map();
async function loginTestServer(url) {
  const response = await global.fetch(url + '/api/auth/session');
  const csrf = (await response.json()).csrfToken;
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const login = await global.fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ username: testAuth.username, password }) });
  if (!login.ok) throw Error('Offline login failed');
  const data = await login.json();
  const session = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
  sessions.set(url, session); return session;
}
function authenticatedFetch(input, options = {}) {
  const session = sessions.get(new URL(input).origin), headers = new Headers(options.headers);
  if (session) { headers.set('Cookie', session.cookie); headers.set('X-CSRF-Token', session.csrf); }
  return global.fetch(input, { ...options, headers });
}
module.exports = { testAuth, testEnv, password, loginTestServer, authenticatedFetch };
