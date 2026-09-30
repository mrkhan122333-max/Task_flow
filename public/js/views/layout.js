// App shell: sidebar navigation, top bar (search + account menu) and content area.

import { api } from '../api.js';
import { store, emit } from '../store.js';
import { icon, avatar, taskFormModal } from '../components.js';
import { esc, debounce, STATUS_META } from '../util.js';

export const NAV = [
  { id: 'home', label: 'Home', icon: 'home', href: '#/' },
  { id: 'tasks', label: 'My Tasks', icon: 'tasks', href: '#/tasks' },
  { id: 'all', label: 'Oversight', icon: 'grid', href: '#/all', admin: true },
  { id: 'projects', label: 'Projects', icon: 'folder', href: '#/projects' },
  { id: 'messages', label: 'Messages', icon: 'chat', href: '#/messages' },
  { id: 'users', label: 'Manage Users', icon: 'users', href: '#/users', admin: true },
];

export function visibleNav() {
  return NAV.filter((n) => !n.admin || store.user.role === 'admin');
}

export function buildShell(root) {
  root.innerHTML =
    '<div class="app-shell">' +
      '<aside class="sidebar" id="sidebar">' +
        '<div class="sidebar-head">' +
          '<div class="auth-brand" style="margin:0">' +
            '<span class="brand-mark" style="width:36px;height:36px;font-size:15px">TF</span>' +
            '<span class="brand-name" style="font-size:18px">TaskFlow</span>' +
          '</div>' +
          '<button type="button" class="icon-btn sidebar-close" id="sidebar-close">' + icon('x', 18) + '</button>' +
        '</div>' +
        '<nav class="sidebar-nav" id="sidebar-nav"></nav>' +
        '<div class="sidebar-foot">' + icon('briefcase', 14) + ' Cosmic Info Solutions</div>' +
      '</aside>' +
      '<div class="sidebar-backdrop" id="sidebar-backdrop"></div>' +
      '<div class="main-col">' +
        '<header class="topbar">' +
          '<button type="button" class="icon-btn menu-btn" id="menu-btn" aria-label="Menu">' + icon('menu', 20) + '</button>' +
          '<div class="search-box" id="search-box">' +
            '<span class="search-icon">' + icon('search', 16) + '</span>' +
            '<input id="global-search" placeholder="Search tasks, projects, people…" autocomplete="off">' +
            '<div class="search-results" id="search-results" hidden></div>' +
          '</div>' +
          '<div class="topbar-right">' +
            '<button type="button" class="btn btn-primary btn-sm btn-new-task" id="new-task-btn">' + icon('plus', 15) + ' New Task</button>' +
            '<div class="account-menu">' +
              '<button type="button" class="account-btn" id="account-btn">' +
                '<span id="acc-avatar"></span>' +
                '<span class="acc-name" id="acc-name"></span>' +
                '<span class="acc-chev">' + icon('chevD', 14) + '</span>' +
              '</button>' +
              '<div class="account-dropdown" id="account-dropdown" hidden>' +
                '<div class="acc-info">' +
                  '<strong id="acc-dn"></strong>' +
                  '<span id="acc-role"></span>' +
                '</div>' +
                '<button type="button" class="app-link" id="logout-btn">' + icon('logout', 16) + ' Sign out</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</header>' +
        '<main class="content" id="content"></main>' +
      '</div>' +
    '</div>';

  const content = document.getElementById('content');
  const navEl = document.getElementById('sidebar-nav');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  // --- Sidebar navigation ---
  function renderNav(activeId) {
    navEl.innerHTML = visibleNav().map((n) =>
      '<button type="button" class="nav-item' + (n.id === activeId ? ' active' : '') + '" data-nav="' + n.id + '">' +
        icon(n.icon, 19) + esc(n.label) + '</button>').join('');
  }
  navEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    const item = NAV.find((n) => n.id === btn.getAttribute('data-nav'));
    if (item) window.location.hash = item.href;
    sidebar.classList.remove('open');
    backdrop.classList.remove('show');
  });

  // --- Account menu ---
  const accountBtn = document.getElementById('account-btn');
  const dropdown = document.getElementById('account-dropdown');
  document.getElementById('acc-name').textContent = store.user.displayName || store.user.username;
  document.getElementById('acc-dn').textContent = store.user.displayName || store.user.username;
  document.getElementById('acc-role').textContent = '@' + store.user.username + ' · ' + (store.user.role === 'admin' ? 'Admin' : 'Analyst');
  document.getElementById('acc-avatar').innerHTML = avatar(store.user, 30);

  accountBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener('click', () => { dropdown.hidden = true; });
  dropdown.addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api.post('/api/auth/logout'); } catch (err) { /* session may be gone */ }
    emit('logged-out');
  });

  // --- Global search ---
  const searchInput = document.getElementById('global-search');
  const resultsEl = document.getElementById('search-results');
  const doSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) { resultsEl.hidden = true; return; }
    try {
      const data = await api.get('/api/search?q=' + encodeURIComponent(q));
      renderSearchResults(data);
    } catch (err) {
      resultsEl.hidden = true;
    }
  }, 220);

  function renderSearchResults(data) {
    const parts = [];
    if (data.tasks && data.tasks.length) {
      parts.push('<div class="search-group">Tasks</div>' + data.tasks.map((t) =>
        '<div class="search-item" data-task="' + esc(t.id) + '">' +
          icon('tasks', 15) + '<span>' + esc(t.title) + '</span>' +
          '<span class="search-kind">' + esc(((STATUS_META[t.status] || {}).label) || t.status) + '</span></div>').join(''));
    }
    if (data.projects && data.projects.length) {
      parts.push('<div class="search-group">Projects</div>' + data.projects.map((p) =>
        '<div class="search-item" data-project="' + esc(p.id) + '">' +
          icon('folder', 15) + '<span style="color:' + esc(p.color) + '">' + esc(p.name) + '</span>' +
          '<span class="search-kind">Project</span></div>').join(''));
    }
    if (data.users && data.users.length) {
      parts.push('<div class="search-group">People</div>' + data.users.map((u) =>
        '<div class="search-item" data-user="' + esc(u.id) + '">' + avatar(u, 22) +
          '<span>' + esc(u.displayName || u.username) + '</span>' +
          '<span class="search-kind">' + esc(u.role) + '</span></div>').join(''));
    }
    if (!parts.length) {
      parts.push('<div class="search-group">No results</div>');
    }
    resultsEl.innerHTML = parts.join('');
    resultsEl.hidden = false;
  }

  resultsEl.addEventListener('click', (e) => {
    const task = e.target.closest('[data-task]');
    const project = e.target.closest('[data-project]');
    const user = e.target.closest('[data-user]');
    resultsEl.hidden = true;
    searchInput.value = '';
    if (task) { emit('open-task', task.getAttribute('data-task')); }
    else if (project) { window.location.hash = '#/tasks?project=' + encodeURIComponent(project.getAttribute('data-project')); }
    else if (user) { window.location.hash = '#/messages/' + encodeURIComponent(user.getAttribute('data-user')); }
  });

  searchInput.addEventListener('input', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { resultsEl.hidden = true; searchInput.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-box')) resultsEl.hidden = true;
  });

  // --- Mobile sidebar ---
  const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
  document.getElementById('menu-btn').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('show', sidebar.classList.contains('open'));
  });
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
  backdrop.addEventListener('click', closeSidebar);

  // --- New Task (admin) ---
  const newTaskBtn = document.getElementById('new-task-btn');
  if (store.user.role !== 'admin') {
    newTaskBtn.hidden = true;
  } else {
    newTaskBtn.addEventListener('click', () => {
      taskFormModal(null, {});
    });
  }

  return { content, renderNav, closeSidebar };
}