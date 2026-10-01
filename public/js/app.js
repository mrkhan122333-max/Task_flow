// Cosmic Info Solutions — Task Management SPA bootstrap, hash router and
// global event wiring.

import { api, onUnauthorized } from './api.js';
import { store, loadCaches, resetStore, on } from './store.js';
import { icon } from './components.js';
import { esc } from './util.js';
import { buildShell } from './views/layout.js';
import { renderLogin } from './views/login.js';
import { renderHome } from './views/home.js';
import { renderTasks } from './views/tasks.js';
import { renderProjects } from './views/projects.js';
import { renderMessages } from './views/messages.js';
import { renderUsers } from './views/users.js';
import { openTask, closeTask, isOpen } from './views/taskDetail.js';

const root = document.getElementById('root');
let shell = null;
let currentClean = null;
let booting = false;

function clearCurrent() {
  if (currentClean) {
    try { currentClean(); } catch (err) { /* ignore */ }
    currentClean = null;
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function showLogin() {
  closeTask();
  clearCurrent();
  shell = null;
  resetStore();
  root.innerHTML = '';
  renderLogin(root, { onSuccess: buildShellAndRoute });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const parts = hash.split('?');
  const params = new URLSearchParams(parts[1] || '');
  const segs = parts[0].split('/').filter(Boolean);
  return { segs, params, raw: hash };
}

// Most views fetch their data, so they are async. Without a catch a failed
// request would leave the spinner on screen and surface as an unhandled
// rejection; this keeps every route failure visible to the user instead.
function runView(render, main, ...args) {
  return Promise.resolve()
    .then(() => render(main, ...args))
    .catch((err) => {
      if (err && err.status === 401) return; // the API layer is already bouncing to login
      if (main) {
        main.innerHTML = '<div class="empty-state">' + icon('alert', 28) +
          '<div class="empty-title">Could not load this page</div>' +
          '<div class="muted">' + esc((err && err.message) || 'Please try again.') + '</div>' +
          '<button type="button" class="btn btn-primary btn-sm" id="retry-view" style="margin-top:12px">Retry</button>' +
          '</div>';
        const retry = main.querySelector('#retry-view');
        if (retry) retry.addEventListener('click', () => route());
      }
    });
}

function route() {
  if (!store.user) { showLogin(); return; }
  if (!shell) return;
  clearCurrent();
  const main = shell.content;
  const { segs, params } = currentRoute();
  const first = segs[0] || 'home';
  const isAdmin = store.user.role === 'admin';

  main.innerHTML = '';

  switch (first) {
    case 'home': {
      shell.renderNav('home');
      runView(renderHome, main);
      break;
    }
    case 'tasks': {
      const mode = params.get('scope') === 'all' && isAdmin ? 'all' : 'mine';
      shell.renderNav(mode === 'all' ? 'all' : 'tasks');
      runView(renderTasks, main, {
        mode,
        title: isAdmin && mode === 'all' ? 'Oversight' : 'My Tasks',
        projectId: params.get('project') || '',
        due: params.get('due') || '',
        overdue: params.get('overdue') || '',
      });
      break;
    }
    case 'all': {
      if (!isAdmin) { window.location.hash = '#/tasks'; return; }
      shell.renderNav('all');
      runView(renderTasks, main, {
        mode: 'all',
        title: 'Oversight — all tasks',
        projectId: params.get('project') || '',
        due: params.get('due') || '',
        overdue: params.get('overdue') || '',
      });
      break;
    }
    case 'projects': {
      shell.renderNav('projects');
      runView(renderProjects, main);
      break;
    }
    case 'messages': {
      shell.renderNav('messages');
      currentClean = renderMessages(main, { selectedId: segs[1] ? decodeURIComponent(segs[1]) : null }).clean;
      break;
    }
    case 'users': {
      if (!isAdmin) { window.location.hash = '#/home'; return; }
      shell.renderNav('users');
      runView(renderUsers, main);
      break;
    }
    default:
      window.location.hash = '#/';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  if (booting) return;
  booting = true;

  // Global events ----------------------------------------------------------
  on('open-task', (id) => { if (id) openTask(id); });
  on('tasks-changed', () => { if (store.user && shell) route(); });
  on('task-updated', () => { if (store.user && shell && !isOpen()) route(); });
  on('data-changed', async () => {
    if (!store.user || !shell) return;
    // A cache refresh failure must not become an unhandled rejection; the view
    // is re-rendered with whatever is cached.
    try { await loadCaches(); } catch (err) { /* keep the stale cache */ }
    route();
  });
  on('logged-out', () => showLogin());

  onUnauthorized(() => {
    if (store.user && !window.location.hash.startsWith('#/login')) {
      showLogin();
    }
  });

  // Restore session if there is one.
  let me = null;
  try {
    me = await api.get('/api/auth/me');
  } catch (err) {
    me = null;
  }

  if (me && me.user) {
    store.user = me.user;
    try {
      await loadCaches();
    } catch (err) { /* non-fatal */ }
    buildShellAndRoute();
  } else {
    showLogin();
  }
}

function buildShellAndRoute() {
  root.innerHTML = '';
  shell = buildShell(root);
  // A hash pointing to a non-existent path gets normalised by the router.
  route();
}

window.addEventListener('hashchange', () => {
  if (store.user) {
    if (shell) route();
    else buildShellAndRoute();
  } else {
    showLogin();
  }
});

// Guard against double-boot on hot-reload style setups.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}