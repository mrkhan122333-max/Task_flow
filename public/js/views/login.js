// Login screen (no public sign-up — accounts are created by admins / seed script).

import { api } from '../api.js';
import { store } from '../store.js';

export function renderLogin(root, opts = {}) {
  root.innerHTML =
    '<div class="auth-page">' +
      '<div class="auth-card">' +
        '<div class="auth-brand">' +
          '<span class="brand-mark">TF</span>' +
          '<span class="brand-name">TaskFlow</span>' +
        '</div>' +
        '<h1>Welcome back</h1>' +
        '<p class="auth-sub">Sign in to your Cosmic Info Solutions workspace</p>' +
        '<form id="login-form" novalidate>' +
          '<div class="field"><label>Username</label>' +
            '<input class="input" id="login-user" name="username" autocomplete="username" maxlength="64" autofocus required></div>' +
          '<div class="field"><label>Password</label>' +
            '<input class="input" type="password" id="login-pass" name="password" autocomplete="current-password" required></div>' +
          '<div class="form-error" id="login-error" hidden></div>' +
          '<button type="submit" class="btn btn-primary btn-block" id="login-btn">Sign in</button>' +
        '</form>' +
        '<p class="auth-foot">Private internal tool · Authorized personnel only</p>' +
      '</div>' +
    '</div>';

  const form = document.getElementById('login-form');
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    if (!username || !password) { showError('Please enter your username and password.'); return; }

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const data = await api.post('/api/auth/login', { username, password });
      store.user = data.user;
      if (opts.onSuccess) opts.onSuccess();
      else window.location.hash = '#/';
    } catch (err) {
      if (err.code === 'NO_USERS') {
        showError('No accounts exist yet. An administrator must run `npm run seed` to create the first admin account.');
      } else {
        showError(err.message || 'Login failed. Please try again.');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}