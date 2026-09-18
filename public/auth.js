'use strict';
// FEATURE/FUNCTION: Session transport. PURPOSE: Keep CSRF tokens in memory and redirect expired sessions without retrying paid requests.
window.Auth = (() => {
  const nativeFetch = window.fetch.bind(window);
  let csrfToken = null;
  const ready = nativeFetch('/api/auth/session', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('Session unavailable.');
    const session = await response.json(); csrfToken = session.csrfToken;
    if (!session.authenticated) window.location.replace('/login');
    return session.authenticated;
  }).catch(() => { window.location.replace('/login'); return false; });
  async function request(url, options = {}) {
    if (!await ready) throw new Error('Sign in to continue.');
    const headers = new Headers(options.headers);
    if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrfToken);
    const response = await nativeFetch(url, { ...options, headers });
    if (response.status === 401) window.location.replace('/login');
    return response;
  }
  document.getElementById('logout').addEventListener('click', async () => {
    const button = document.getElementById('logout'); button.disabled = true;
    try { const response = await request('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(); window.location.replace('/login');
    } catch { button.disabled = false; button.textContent = 'Logout failed · Retry'; }
  });
  return { request, ready };
})();
