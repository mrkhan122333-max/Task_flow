// Home / dashboard.
//
// The numbers come from /api/stats so the dashboard always matches the task
// list and the automatic Overdue rule, even if the page was left open overnight.
//   Admin    → Total Tasks · In Progress · Completed · Overdue · Due Today
//   Employee → My Tasks   · Due Today · Overdue · Completed
// The overdue watchlist and the recent list still come from the task API so the
// cards are clickable.

import { api } from '../api.js';
import { store, userById, emit } from '../store.js';
import { statusBadge, emptyState, spinner, taskCard, icon } from '../components.js';
import { esc, fmtDate, taskIsOverdue, roleLabel } from '../util.js';

export async function renderHome(main) {
  main.innerHTML = spinner();

  const isAdmin = store.user.role === 'admin';
  const [stats, taskData, workloadData] = await Promise.all([
    api.get('/api/stats'),
    api.get('/api/tasks'),
    isAdmin ? api.get('/api/stats/workload').catch(() => ({ workload: [] })) : Promise.resolve({ workload: [] }),
  ]);

  const m = stats.metrics;
  const tasks = taskData.tasks || [];
  // Server-computed flag, so the watchlist matches the Overdue filter exactly.
  const overdue = tasks.filter(taskIsOverdue);
  const recent = tasks.slice()
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, 8);

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
      '<div><div class="stat-value">' + esc(String(value)) + '</div><div class="stat-label">' + esc(label) + '</div></div>' +
    '</div>';

  const statGrid = isAdmin
    ? statGridHtml([
        stat(m.total, 'Total tasks', 'total'),
        stat(m.inProgress, 'In progress', 'progress'),
        stat(m.completed, 'Completed', 'done'),
        stat(m.overdue, 'Overdue', 'overdue'),
        stat(m.dueToday, 'Due today', 'today'),
      ])
    : statGridHtml([
        stat(m.total, 'My tasks', 'total'),
        stat(m.dueToday, 'Due today', 'today'),
        stat(m.overdue, 'Overdue', 'overdue'),
        stat(m.completed, 'Completed', 'done'),
      ]);

  let workload = '';
  if (isAdmin && (workloadData.workload || []).length) {
    workload =
      '<div class="card mb-16">' +
        '<h3 class="section-title"><span>Workload by employee</span></h3>' +
        '<div class="chip-list">' +
          workloadData.workload.map((row) => {
            const u = row.userId ? userById(row.userId) : null;
            const pct = row.total ? Math.round((row.completed / row.total) * 100) : 0;
            const name = u ? (u.displayName || u.username) : 'Unassigned';
            return '<div class="detail-box" style="flex:1;min-width:180px">' +
              '<div class="dlabel">' + esc(name) +
                (u && u.active === false ? ' <span class="muted" style="font-weight:400">(inactive)</span>' : '') +
              '</div>' +
              '<div class="inline-flex" style="width:100%;gap:10px">' +
                '<div class="sub-progress"><span style="width:' + pct + '%"></span></div>' +
                '<span class="muted" style="font-size:12px">' + row.completed + '/' + row.total + '</span>' +
              '</div>' +
              (row.overdue
                ? '<div style="font-size:12px;margin-top:4px;color:#dc2626">' + row.overdue + ' overdue</div>'
                : '') +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  main.innerHTML =
    '<div class="content-narrow">' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>' + esc(isAdmin ? 'Good day, ' + (store.user.displayName || store.user.username) : 'My dashboard') + '</h1>' +
          '<div class="page-sub">' + esc(
            isAdmin
              ? 'Company-wide task overview'
              : 'Everything assigned to you',
          ) + '</div>' +
        '</div>' +
      '</div>' +
      statGrid +
      workload +
      '<div class="card mb-16">' +
        '<div class="flex-between" style="margin-bottom:6px">' +
          '<h3 class="section-title">Overdue tasks</h3>' +
          (overdue.length ? '<button class="btn btn-ghost btn-sm" id="go-overdue">View all</button>' : '') +
        '</div>' +
        (overdue.length === 0
          ? '<p class="muted" style="padding:6px 0">Nothing overdue. Everything is on track.</p>'
          : '<div style="display:flex;flex-direction:column;gap:8px">' +
              overdue.slice(0, 6).map((t) => {
                const assignee = t.assigneeId ? userById(t.assigneeId) : null;
                return '<div class="mini-card" data-task-id="' + esc(t.id) + '">' +
                  '<div class="mc-title">' + esc(t.title) + '</div>' +
                  '<div class="mc-meta">' + statusBadge(t.status) +
                    '<span class="mc-chip overdue">' + esc(fmtDate(t.dueDate)) + ' · overdue</span>' +
                    (assignee ? '<span class="muted" style="font-size:12px">' + esc(assignee.displayName || assignee.username) + '</span>' : '') +
                  '</div></div>';
              }).join('') +
            '</div>') +
      '</div>' +
      '<div class="card">' +
        '<div class="flex-between" style="margin-bottom:6px">' +
          '<h3 class="section-title">Recently updated</h3>' +
          '<a href="#/tasks" class="muted" style="font-size:13px">View all →</a>' +
        '</div>' +
        (recent.length === 0
          ? emptyState('tasks', 'No tasks yet', isAdmin
              ? 'Nothing has been created yet. Use the New Task button to get started.'
              : 'Tasks assigned to you will show up here. Ask an Admin to assign work or to add you to a project.')
          : '<div style="display:flex;flex-direction:column;gap:8px">' +
              recent.map((t) => taskCard(t, { draggable: false })).join('') +
            '</div>') +
      '</div>' +
      '<p class="muted" style="font-size:12px;text-align:center;margin-top:16px">' +
        'Signed in as ' + esc(roleLabel(store.user.role)) + ' · figures as of ' + esc(fmtDate(stats.today)) + '</p>' +
    '</div>';

  main.querySelectorAll('[data-task-id]').forEach((node) => {
    node.addEventListener('click', () => emit('open-task', node.getAttribute('data-task-id')));
  });
  const goOverdue = document.getElementById('go-overdue');
  if (goOverdue) goOverdue.addEventListener('click', () => { window.location.hash = '#/tasks?overdue=1'; });
}

function statGridHtml(cards) {
  return '<div class="stat-grid">' + cards.join('') + '</div>';
}
