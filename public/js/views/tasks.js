// Tasks view — Kanban board and list with filters, drag & drop, and scoping.
//   mode 'mine' → the caller's own assignments
//   mode 'all'  → admin Oversight (every task in the company)
//
// The server applies the access rule (admin = everything, employee = assigned
// or a project they belong to) and derives `overdue` / `dueToday`, so the board
// can never show work the user is not allowed to see.

import { api } from '../api.js';
import { store, emit } from '../store.js';
import {
  icon, spinner, emptyState, toast, taskCard, taskRow, taskFormModal, statusOptions,
} from '../components.js';
import { esc, STATUS, STATUS_META, PRIORITY_META } from '../util.js';

const VIEW_KEY = 'cosmic-tasks-view';

export function renderTasks(main, opts) {
  const state = {
    mode: opts.mode || 'mine',
    projectId: opts.projectId || '',
    status: '',
    priority: '',
    assigneeId: '',
    due: opts.due || '',
    overdue: opts.overdue === '1',
    sort: 'updated',
    view: localStorage.getItem(VIEW_KEY) || 'board',
    tasks: [],
    draggingId: null,
  };

  const header = '<div class="content-narrow">' +
    '<div class="page-head">' +
      '<div>' +
        '<h1>' + esc(opts.title || (state.mode === 'all' ? 'All Tasks' : 'My Tasks')) + '</h1>' +
        '<div class="page-sub" id="tasks-subtitle">Loading…</div>' +
      '</div>' +
      '<div class="page-actions">' +
        (store.user.role === 'admin'
          ? '<button type="button" class="btn btn-primary btn-sm" id="new-task">' + icon('plus', 15) + ' New Task</button>'
          : '') +
        '<div class="view-toggle">' +
          '<button type="button" data-view="list" id="view-list">' + icon('list', 15) + ' List</button>' +
          '<button type="button" data-view="board" id="view-board">' + icon('grid', 15) + ' Board</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="filter-bar" id="filter-bar"></div>' +
    '<div id="tasks-body">' + spinner() + '</div>' +
  '</div>';

  main.innerHTML = header;

  // ---------- filters ----------
  function filterBarHTML() {
    const selects = [
      '<div class="select-wrap"><select id="f-status" class="input"><option value="">All statuses</option>' +
        statusOptions(state.status) + '</select>' + icon('chevD', 14) + '</div>',
      '<div class="select-wrap"><select id="f-priority" class="input"><option value="">All priorities</option>' +
        Object.keys(PRIORITY_META).map((p) =>
          '<option value="' + p + '"' + (state.priority === p ? ' selected' : '') + '>' + esc(PRIORITY_META[p].label) + '</option>').join('') +
        '</select>' + icon('chevD', 14) + '</div>',
      '<div class="select-wrap"><select id="f-project" class="input"><option value="">All projects</option>' +
        store.projects.map((p) => '<option value="' + esc(p.id) + '"' + (state.projectId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>' + icon('chevD', 14) + '</div>',
    ];
    if (store.user.role === 'admin') {
      selects.push('<div class="select-wrap"><select id="f-assignee" class="input"><option value="">Any assignee</option>' +
        store.users.map((u) => '<option value="' + esc(u.id) + '"' + (state.assigneeId === u.id ? ' selected' : '') + '>' +
          esc(u.displayName || u.username) + (u.active === false ? ' (inactive)' : '') + '</option>').join('') +
        '</select>' + icon('chevD', 14) + '</div>');
    }
    selects.push('<div class="select-wrap"><select id="f-due" class="input">' +
      '<option value="">Any due date</option>' +
      '<option value="overdue"' + (state.due === 'overdue' ? ' selected' : '') + '>Overdue</option>' +
      '<option value="today"' + (state.due === 'today' ? ' selected' : '') + '>Due today</option>' +
      '<option value="week"' + (state.due === 'week' ? ' selected' : '') + '>Due in next 7 days</option>' +
      '<option value="month"' + (state.due === 'month' ? ' selected' : '') + '>Due in next 30 days</option>' +
      '<option value="none"' + (state.due === 'none' ? ' selected' : '') + '>No due date</option>' +
      '</select>' + icon('chevD', 14) + '</div>');
    selects.push('<div class="select-wrap"><select id="f-sort" class="input"><option value="updated"' + (state.sort === 'updated' ? ' selected' : '') + '>Sort: recently updated</option>' +
      '<option value="created"' + (state.sort === 'created' ? ' selected' : '') + '>Sort: newest first</option>' +
      '<option value="due"' + (state.sort === 'due' ? ' selected' : '') + '>Sort: due date</option>' +
      '<option value="priority"' + (state.sort === 'priority' ? ' selected' : '') + '>Sort: priority (Critical → Low)</option></select>' + icon('chevD', 14) + '</div>');
    selects.push('<button type="button" class="filter-chip' + (state.overdue ? ' active' : '') + '" id="f-overdue">' +
      icon('alert', 13) + ' Overdue only</button>');
    return selects.join('');
  }

  document.getElementById('filter-bar').innerHTML = filterBarHTML();

  const bindFilters = () => {
    const pick = (id) => document.getElementById(id);
    const onChange = (id, key) => pick(id).addEventListener('change', () => {
      state[key] = pick(id).value;
      load();
    });
    onChange('f-status', 'status');
    onChange('f-priority', 'priority');
    onChange('f-project', 'projectId');
    if (store.user.role === 'admin') onChange('f-assignee', 'assigneeId');
    onChange('f-due', 'due');
    pick('f-sort').addEventListener('change', () => { state.sort = pick('f-sort').value; load(); });

    // Overdue toggle
    const overdueChip = document.getElementById('f-overdue');
    if (overdueChip) overdueChip.addEventListener('click', () => {
      state.overdue = !state.overdue;
      overdueChip.classList.toggle('active', state.overdue);
      load();
    });

    document.getElementById('view-list').addEventListener('click', () => { setView('list'); });
    document.getElementById('view-board').addEventListener('click', () => { setView('board'); });

    const newTask = document.getElementById('new-task');
    if (newTask) newTask.addEventListener('click', () => taskFormModal(null, { projectId: state.projectId || undefined }));
  };

  function setView(v) {
    state.view = v;
    localStorage.setItem(VIEW_KEY, v);
    document.getElementById('view-list').classList.toggle('active', v === 'list');
    document.getElementById('view-board').classList.toggle('active', v === 'board');
    renderBody();
  }

  async function load() {
    const params = new URLSearchParams();
    params.set('sort', state.sort);
    if (state.status) params.set('status', state.status);
    if (state.priority) params.set('priority', state.priority);
    if (state.projectId) params.set('projectId', state.projectId);
    if (state.due) params.set('due', state.due);
    if (state.overdue) params.set('overdue', '1');
    // "My Tasks" is always the caller's own work; Oversight is the company view.
    // (An employee's board otherwise also lists project work they can open.)
    if (state.mode === 'mine') params.set('assigneeId', store.user.id);
    else if (state.assigneeId && store.user.role === 'admin') params.set('assigneeId', state.assigneeId);
    try {
      const data = await api.get('/api/tasks?' + params.toString());
      state.tasks = data.tasks;
    } catch (err) {
      toast(err.message || 'Could not load tasks.', 'error');
      state.tasks = [];
    }
    const overdueCount = state.tasks.filter((t) => t.overdue).length;
    document.getElementById('tasks-subtitle').textContent =
      state.tasks.length + ' task' + (state.tasks.length === 1 ? '' : 's') +
      (overdueCount ? ' · ' + overdueCount + ' overdue' : '');
    renderBody();
  }

  function sortTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      if (state.sort === 'due') {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      if (state.sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
      if (state.sort === 'priority') {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        const pa = order[a.priority] === undefined ? 2 : order[a.priority];
        const pb = order[b.priority] === undefined ? 2 : order[b.priority];
        if (pa !== pb) return pa - pb;
        return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
      }
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
    });
  }

  // ---------- body rendering ----------
  function renderBody() {
    const bodyEl = document.getElementById('tasks-body');
    const tasks = sortTasks(state.tasks);
    if (state.view === 'list') {
      if (!tasks.length) {
        bodyEl.innerHTML = emptyState('tasks', 'No tasks match', 'Try changing the filters above, or create a new task.');
        return;
      }
      bodyEl.innerHTML = '<div class="card" style="padding:0;overflow:hidden">' +
        '<table class="task-table">' +
          '<thead><tr><th>Task</th><th>Status</th><th>Assignee</th><th>Due</th><th>Subtasks</th><th></th></tr></thead>' +
          '<tbody>' + tasks.map(taskRow).join('') + '</tbody>' +
        '</table></div>';
      bodyEl.querySelectorAll('tr[data-task-id]').forEach((tr) => {
        tr.addEventListener('click', () => emit('open-task', tr.getAttribute('data-task-id')));
      });
      return;
    }

    // Board
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

    bodyEl.innerHTML = '<div class="board" id="board">' + STATUS.map((s) => {
      const meta = STATUS_META[s];
      const colTasks = tasks.filter((t) => t.status === s);
      return '<div class="board-col" data-status="' + s + '">' +
        '<div class="board-col-head" style="color:' + meta.color + '">' +
          '<span class="dot" style="width:9px;height:9px;border-radius:50%;background:' + meta.color + ';display:inline-block"></span>' +
          esc(meta.label) +
          '<span class="count">' + (counts[s] || 0) + '</span>' +
        '</div>' +
        '<div class="board-col-body">' +
          (colTasks.length ? colTasks.map((t) => taskCard(t, { draggable: true })).join('') : '<div class="muted" style="font-size:12px;padding:6px 2px">—</div>') +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    const board = bodyEl.querySelector('#board');
    board.querySelectorAll('[data-task-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (state.draggingId) return;
        emit('open-task', card.getAttribute('data-task-id'));
      });
      card.addEventListener('dragstart', (e) => {
        state.draggingId = card.getAttribute('data-task-id');
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', state.draggingId); } catch (err) { /* noop */ }
      });
      card.addEventListener('dragend', () => {
        state.draggingId = null;
        card.classList.remove('dragging');
        board.querySelectorAll('.board-col').forEach((c) => c.classList.remove('drag-over'));
      });
    });

    board.querySelectorAll('.board-col').forEach((col) => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('drag-over');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const taskId = state.draggingId || (e.dataTransfer.getData('text/plain')) || null;
        const status = col.getAttribute('data-status');
        if (!taskId || !status) return;
        const task = state.tasks.find((t) => t.id === taskId);
        if (!task || task.status === status) return;
        try {
          await api.put('/api/tasks/' + taskId + '/status', { status });
          emit('task-updated', { id: taskId });
          toast('Moved to ' + STATUS_META[status].label + '.');
        } catch (err) {
          toast(err.message || 'Move failed.', 'error');
          load();
        }
      });
    });
  }

  bindFilters();
  load();

  return {};
}