// Home / dashboard — stats, overdue watchlist and recent tasks.
// Admins see company-wide numbers; Analysts see their own scope.

import { api } from '../api.js';
import { store, userById, emit } from '../store.js';
import { statusBadge, emptyState, spinner, taskCard, icon } from '../components.js';
import { esc, fmtDate, isOverdue, todayISO } from '../util.js';

export async function renderHome(main) {
  main.innerHTML = spinner();
  const data = await api.get('/api/tasks');
  const tasks = data.tasks;

  const isAdmin = store.user.role === 'admin';
  const total = tasks.length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress' || t.status === 'on_hold').length;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const dueToday = tasks.filter((t) => t.dueDate === todayISO() && t.status !== 'completed').length;
  const overdue = tasks.filter(isOverdue);
  const recent = tasks.slice().sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')).slice(0, 8);

  const statIcons = {
    total: { ic: 'clipboard', bg: 'linear-gradient(135deg,#2563eb,#4f46e5)' },
    progress: { ic: 'clock', bg: 'linear-gradient(135deg,#d97706,#ea580c)' },
    today: { ic: 'calendar', bg: 'linear-gradient(135deg,#0891b2,#0e7490)' },
    done: { ic: 'check', bg: 'linear-gradient(135deg,#10b981,#059669)' },
    overdue: { ic: 'alert', bg: 'linear-gradient(135deg,#dc2626,#b91c1c)' },
  };

  const stat = (value, label, key) =>
    '<div class="card stat-card">' +
      '<span class="stat-icon" style="background:' + statIcons[key].bg + '">' + icon(statIcons[key].ic, 20) + '</span>' +
      '<div><div class="stat-value">' + value + '</div><div class="stat-label">' + esc(label) + '</div></div>' +
    '</div>';

  let perAnalyst = '';
  if (isAdmin) {
    const counts = {};
    for (const t of tasks) {
      const key = t.assigneeId || 'unassigned';
      counts[key] = counts[key] || { total: 0, done: 0 };
      counts[key].total += 1;
      if (t.status === 'completed') counts[key].done += 1;
    }
    const rows = Object.keys(counts)
      .map((key) => ({ key, ...counts[key] }))
      .sort((a, b) => b.total - a.total);
    perAnalyst =
      '<div class="card mb-16">' +
        '<h3 class="section-title"><span>' + esc('Workload by assignee') + '</span></h3>' +
        '<div class="chip-list">' +
          (rows.length ? rows.map((r) => {
            const u = userById(r.key);
            const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
            return '<div class="detail-box" style="flex:1;min-width:180px">' +
              '<div class="dlabel">' + (u ? esc(u.displayName) : 'Unassigned') + '</div>' +
              '<div class="inline-flex" style="width:100%;gap:10px">' +
                '<div class="sub-progress"><span style="width:' + pct + '%"></span></div>' +
                '<span class="muted" style="font-size:12px">' + r.done + '/' + r.total + '</span>' +
              '</div></div>';
          }).join('') : '<p class="muted">No tasks assigned yet.</p>') +
        '</div>' +
      '</div>';
  }

  main.innerHTML =
    '<div class="content-narrow">' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>' + esc(isAdmin ? 'Good day, ' + (store.user.displayName || store.user.username) : 'My dashboard') + '</h1>' +
          '<div class="page-sub">' + esc(isAdmin ? 'Company-wide task overview' : 'Here is the work assigned to you') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stat-grid">' +
        stat(total, 'Total tasks', 'total') +
        stat(inProgress, 'In progress', 'progress') +
        stat(dueToday, 'Due today', 'today') +
        stat(overdue.length, 'Overdue', 'overdue') +
      '</div>' +
      perAnalyst +
      '<div class="card mb-16">' +
        '<div class="flex-between" style="margin-bottom:6px">' +
          '<h3 class="section-title">' + esc('Overdue tasks') + '</h3>' +
          (overdue.length
            ? '<button class="btn btn-ghost btn-sm" id="go-overdue">' + esc('View all') + '</button>'
            : '') +
        '</div>' +
        (overdue.length === 0
          ? '<p class="muted" style="padding:6px 0">Nothing overdue. Everything on track.</p>'
          : '<div style="display:flex;flex-direction:column;gap:8px">' +
              overdue.slice(0, 6).map((t) => {
                const assignee = userById(t.assigneeId);
                return '<div class="mini-card" data-task-id="' + esc(t.id) + '">' +
                  '<div class="mc-title">' + esc(t.title) + '</div>' +
                  '<div class="mc-meta">' + statusBadge(t.status) +
                    '<span class="mc-chip overdue">' + esc(fmtDate(t.dueDate)) + ' · overdue</span>' +
                    (assignee ? '<span class="muted" style="font-size:12px">' + esc(assignee.displayName) + '</span>' : '') +
                  '</div></div>';
              }).join('') +
            '</div>') +
      '</div>' +
      '<div class="card">' +
        '<div class="flex-between" style="margin-bottom:6px">' +
          '<h3 class="section-title">' + esc('Recently updated') + '</h3>' +
          '<a href="#/tasks" class="muted" style="font-size:13px">View all →</a>' +
        '</div>' +
        (recent.length === 0
          ? emptyState('tasks', 'No tasks yet', 'Tasks assigned to you will show up here (or create the first one from the New Task button).')
          : '<div style="display:flex;flex-direction:column;gap:8px">' +
              recent.map((t) => taskCard(t, { draggable: false })).join('') +
            '</div>') +
      '</div>' +
    '</div>';

  main.querySelectorAll('[data-task-id]').forEach((node) => {
    node.addEventListener('click', () => emit('open-task', node.getAttribute('data-task-id')));
  });
  const goOverdue = document.getElementById('go-overdue');
  if (goOverdue) {
    goOverdue.addEventListener('click', () => { window.location.hash = '#/tasks?overdue=1'; });
  }
}