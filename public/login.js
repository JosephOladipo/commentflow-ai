'use strict';
// FEATURE/FUNCTION: Login submission. PURPOSE: Send one CSRF-protected request and never persist credentials.
const form = document.getElementById('login-form'), button = document.getElementById('sign-in'), message = document.getElementById('login-status');
let token, busy = false;
const ready = fetch('/api/auth/session', { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw new Error(); const session = await response.json(); token = session.csrfToken;
  if (session.authenticated) window.location.replace('/');
}).catch(() => { message.textContent = 'Unable to prepare sign-in. Refresh the page.'; });
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; busy = true; button.disabled = true;
  try {
    await ready; if (!token) throw new Error('Refresh the page before signing in.');
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value }),
      signal: AbortSignal.timeout(15000) });
    document.getElementById('password').value = '';
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'Sign-in failed.');
    window.location.replace('/');
  } catch (error) { message.textContent = error.name === 'TimeoutError' || error instanceof TypeError ? 'Sign-in connection failed. Try again when ready.' : error.message; }
  finally { busy = false; button.disabled = false; }
});
