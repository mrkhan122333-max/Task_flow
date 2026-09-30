// Reusable UI building blocks: icons, avatars, badges, toasts, modals,
// empty states and task cards.

import { api } from './api.js';
import { store, userById, projectById } from './store.js';
import { emit } from './store.js';
import {
  esc, STATUS, STATUS_META, PRIORITY_META, uid, avatarGradient, initials, fmtDate,
  isOverdue,
} from './util.js';

// ---------------------------------------------------------------------------
// Icons (24x24, stroke = currentColor, feather-style paths)
// ---------------------------------------------------------------------------
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  tasks: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9h8M8 13h4"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  menu: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  chevL: '<polyline points="15 18 9 12 15 6"/>',
  chevR: '<polyline points="9 18 15 12 9 6"/>',
  chevD: '<polyline points="6 9 12 15 18 9"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
};

export function icon(name, size = 18) {
  const path = ICONS[name] || ICONS.file;
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
    '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    path + '</svg>';
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
export function avatar(user, size = 28) {
  let name = '?';
  let id = '?';
  if (user) {
    name = user.displayName || user.username || '?';
    id = user.id || name;
  }
  const fontSize = Math.max(10, Math.round(size * 0.4));
  return '<span class="avatar" style="width:' + size + 'px;height:' + size +
    'px;font-size:' + fontSize + 'px;background:' + avatarGradient(id) + '" title="' + esc(name) + '">' +
    esc(initials(name)) + '</span>';
}

// ---------------------------------------------------------------------------
// Status badge & pill
// ---------------------------------------------------------------------------
export function statusBadge(status) {
  const meta = STATUS_META[status] || STATUS_META.not_started;
  return '<span class="badge" style="background:' + meta.bg + ';color:' + meta.color + '">' +
    '<span class="dot"></span>' + esc(meta.label) + '</span>';
}

export function statusOptions(selected) {
  return STATUS.map((s) => {
    const meta = STATUS_META[s];
    return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + esc(meta.label) + '</option>';
  }).join('');
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
export function toast(message, type = 'success') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  const ic = type === 'success' ? 'check' : (type === 'error' ? 'alert' : 'inbox');
  el.innerHTML = '<span class="toast-icon">' + icon(ic, 17) + '</span><span>' + esc(message) + '</span>';
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export function openModal({ title, body, okText = 'Save', onOk, onClose, danger = false, hideOk = false, wide = false, closable = true }) {
  const root = document.getElementById('modal-root');
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.innerHTML =
    '<div class="modal-card' + (wide ? ' modal-wide' : '') + '" role="dialog">' +
      '<div class="modal-head">' +
        '<h3 class="modal-title">' + esc(title) + '</h3>' +
        '<button type="button" class="icon-btn modal-x">' + icon('x', 18) + '</button>' +
      '</div>' +
      '<div class="modal-body"></div>' +
      (hideOk ? '' :
        '<div class="modal-foot">' +
          '<button type="button" class="btn btn-ghost" data-cancel>' + esc('Cancel') + '</button>' +
          '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-ok>' + esc(okText) + '</button>' +
        '</div>') +
    '</div>';
  root.appendChild(el);

  const bodyEl = el.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  el.querySelector('.modal-x').addEventListener('click', close);
  const cancelBtn = el.querySelector('[data-cancel]');
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (closable) {
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  }

  const okBtn = el.querySelector('[data-ok]');
  if (okBtn) {
    okBtn.addEventListener('click', async () => {
      if (okBtn.disabled) return;
      okBtn.disabled = true;
      okBtn.classList.add('is-loading');
      try {
        const result = await onOk({ close });
        if (result !== false) close();
      } catch (err) {
        toast(err.message || 'Something went wrong.', 'error');
      } finally {
        okBtn.disabled = false;
        okBtn.classList.remove('is-loading');
      }
    });
  }

  // Focus the first input.
  const firstInput = bodyEl.querySelector('input,textarea,select');
  if (firstInput) setTimeout(() => { try { firstInput.focus(); } catch (e) { /* noop */ } }, 30);

  return { close };
}

export function confirmModal(message, okText = 'Delete') {
  return new Promise((resolve) => {
    openModal({
      title: 'Please confirm',
      body: '<p class="muted" style="padding:2px 0 6px">' + esc(message) + '</p>',
      okText,
      danger: true,
      onOk: async () => resolve(true),
      onClose: () => resolve(false),
    });
  });
}

// ---------------------------------------------------------------------------
// Loading + empty states
// ---------------------------------------------------------------------------
export function spinner() {
  return '<div class="spinner"></div>';
}

export function emptyState(question, title, description) {
  return '<div class="empty-state">' +
    '<div class="empty-ic">' + icon(question, 28) + '</div>' +
    '<h3>' + esc(title) + '</h3>' +
    '<p>' + esc(description) + '</p>' +
  '</div>';
}

// ---------------------------------------------------------------------------
// Task cards (board + list)
// ---------------------------------------------------------------------------
export function subtaskInfo(task) {
  const subs = task.subtasks || [];
  const done = subs.filter((s) => s.done).length;
  const pct = subs.length ? Math.round((done / subs.length) * 100) : 0;
  return { subs, done, pct };
}

function dueChip(task) {
  if (!task.dueDate) return '';
  const overdue = isOverdue(task);
  const cls = overdue ? 'mc-chip overdue' : 'mc-chip';
  const ic = overdue ? 'alert' : 'calendar';
  return '<span class="' + cls + '">' + icon(ic, 13) + ' ' + esc(fmtDate(task.dueDate)) + '</span>';
}

// Resolve the project chip data for a task. Tasks carry a read-only projection
// (projectName/projectColor) added server-side, so the chip still renders when
// the viewing analyst is not a member of the task's project. Fall back to the
// scoped project cache for older payloads and admin callers.
export function projectInfo(task) {
  if (!task || !task.projectId) return null;
  if (task.projectName && task.projectColor) return { name: task.projectName, color: task.projectColor };
  return projectById(task.projectId);
}

function projectChip(task) {
  const p = projectInfo(task);
  if (!p) return '';
  return '<span class="proj-chip"><span class="dot" style="background:' + esc(p.color) + '"></span>' + esc(p.name) + '</span>';
}

// Small priority indicator with a colored dot + label. Missing priority is
// treated as Medium (old tasks).
export function priorityChip(task) {
  const meta = PRIORITY_META[(task && task.priority) || 'medium'] || PRIORITY_META.medium;
  return '<span class="mc-chip" title="' + esc(meta.label) + ' priority">' +
    '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + meta.color + '"></span>' +
    ' ' + esc(meta.label) + '</span>';
}

// Compact board card.
export function taskCard(task, { draggable = false } = {}) {
  const meta = STATUS_META[task.status] || STATUS_META.not_started;
  const prog = subtaskInfo(task);
  const assignee = task.assigneeId ? userById(task.assigneeId) : null;

  let foot = '';
  if (prog.subs.length) {
    foot += '<span class="mc-chip" title="' + prog.done + ' of ' + prog.subs.length + ' subtasks done">' +
      icon('check', 13) + '</span>';
  }
  if (task.commentCount) foot += '<span class="mc-chip">' + icon('comment', 13) + ' ' + task.commentCount + '</span>';
  if (task.filesCount) foot += '<span class="mc-chip">' + icon('paperclip', 13) + ' ' + task.filesCount + '</span>';

  return '<div class="mini-card' + (draggable ? ' drag-src' : '') + '" data-task-id="' + esc(task.id) + '"' +
    (draggable ? ' draggable="true"' : '') + '>' +
    '<div class="mc-title">' + esc(task.title) + '</div>' +
    '<div class="mc-meta">' + priorityChip(task) + projectChip(task) + dueChip(task) + '</div>' +
    (prog.subs.length
      ? '<div class="mc-foot"><div class="sub-progress"><span style="width:' + prog.pct + '%"></span></div></div>'
      : '') +
    '<div class="mc-foot">' + foot +
      (assignee ? '<span class="avatar" style="width:22px;height:22px;font-size:9px;background:' + avatarGradient(assignee.id) + '">' + esc(initials(assignee.displayName || assignee.username)) + '</span>' : '') +
    '</div>' +
    '<div class="mini-card-status" style="border-top:3px solid ' + meta.color + ';margin:9px -12px -11px;border-radius:0 0 9px 9px;height:0"></div>' +
  '</div>';
}

// Full row used in list view tables.
export function taskRow(task) {
  const prog = subtaskInfo(task);
  const assignee = task.assigneeId ? userById(task.assigneeId) : null;
  const overdue = isOverdue(task);
  return '<tr data-task-id="' + esc(task.id) + '">' +
    '<td><div class="task-title">' + esc(task.title) + '</div>' +
      '<div class="muted" style="font-size:12px">' + priorityChip(task) + projectChip(task) + '</div></td>' +
    '<td>' + statusBadge(task.status) + '</td>' +
    '<td>' + (assignee ? avatar(assignee, 24) + ' <span style="vertical-align:middle">' + esc(assignee.displayName || assignee.username) + '</span>' : '<span class="muted">—</span>') + '</td>' +
    '<td class="task-due">' + (task.dueDate
      ? (overdue ? '<span style="color:var(--c-red);font-weight:600">' + esc(fmtDate(task.dueDate)) + '</span>' : esc(fmtDate(task.dueDate)))
      : '<span class="muted">—</span>') + '</td>' +
    '<td>' + (prog.subs.length ? '<span class="muted">' + prog.done + '/' + prog.subs.length + '</span>' : '<span class="muted">—</span>') + '</td>' +
    '<td>' + (task.commentCount ? '<span class="badge badge-muted">' + icon('comment', 12) + ' ' + task.commentCount + '</span>' : '') + '</td>' +
  '</tr>';
}

// ---------------------------------------------------------------------------
// Task create/edit form (admin)
// ---------------------------------------------------------------------------

// Builds the innerHTML for the Assignee <select>. When a project is selected,
// only analysts listed in that project's memberIds are offered ("Unassigned" is
// always available). `selectedId` is force-included so an existing assignment is
// never silently dropped during an edit.
function assigneeOptionsFor(projectId, selectedId) {
  const project = projectId ? store.projects.find((p) => p.id === projectId) : null;
  const members = project ? new Set(project.memberIds || []) : null;
  const users = store.users.filter((u) => u.role === 'analyst' && (!members || members.has(u.id)));
  if (selectedId && !users.some((u) => u.id === selectedId)) {
    const current = store.users.find((u) => u.id === selectedId);
    if (current) users.unshift(current);
  }
  return '<option value="">Unassigned</option>' + users.map((x) =>
    '<option value="' + esc(x.id) + '"' + (x.id === selectedId ? ' selected' : '') + '>' +
      esc(x.displayName || x.username) + ' (' + esc(x.role) + ')</option>').join('');
}

export function taskFormModal(task, preset = {}, onSaved = null) {
  const isEdit = !!task;

  // The Assignee list depends on the project, so seed it from the task's
  // current project (or preset.projectId for new tasks).
  const initialProjectId = (task && task.projectId) || (preset && preset.projectId) || '';
  const initialAssigneeId = (task && task.assigneeId) || (preset && preset.assigneeId) || '';

  const projectOpts =
    '<select class="input" name="projectId">' + '<option value="">No project</option>' + store.projects.map((p) =>
      '<option value="' + esc(p.id) + '"' + (task && task.projectId === p.id || (!task && preset.projectId === p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>';
  // Default priority is Medium (matches the server default).
  const priorityCurrent = (task && task.priority) || 'medium';
  const priorityOpts =
    '<select class="input" name="priority">' + Object.keys(PRIORITY_META).map((p) =>
      '<option value="' + p + '"' + (p === priorityCurrent ? ' selected' : '') + '>' + esc(PRIORITY_META[p].label) + '</option>').join('') + '</select>';

  const subLines = task ? (task.subtasks || []).map((s) => s.text).join('\n') : '';
  const formId = uid();

  const body = document.createElement('div');
  body.innerHTML =
    '<form id="' + formId + '" novalidate>' +
      '<div class="field"><label>Title *</label><input class="input" name="title" maxlength="200" required ' +
        'value="' + esc(task ? task.title : preset.title || '') + '"></div>' +
      '<div class="field"><label>Description</label><textarea class="input" name="description" maxlength="5000" rows="3">' +
        esc(task ? task.description : preset.description || '') + '</textarea></div>' +
      '<div class="field"><label>Project</label><div class="select-wrap">' + projectOpts + icon('chevD', 14) + '</div></div>' +
      '<div class="input-row">' +
        '<div class="field"><label>Assignee</label><div class="select-wrap" id="assignee-field-wrap"><select class="input" name="assigneeId">' + assigneeOptionsFor(initialProjectId, initialAssigneeId) + '</select>' + icon('chevD', 14) + '</div></div>' +
        '<div class="field"><label>Start date</label><input class="input" type="date" name="startDate" value="' +
          esc((task && task.startDate) || preset.startDate || '') + '"></div>' +
        '<div class="field"><label>Due date</label><input class="input" type="date" name="dueDate" value="' +
          esc((task && task.dueDate) || preset.dueDate || '') + '"></div>' +
      '</div>' +
      (isEdit
        ? '<div class="field"><label>Status</label><div class="select-wrap"><select class="input" name="status">' +
            statusOptions(task.status) + '</select>' + icon('chevD', 14) + '</div></div>'
        : '') +
      '<div class="field"><label>Priority</label><div class="select-wrap">' + priorityOpts + icon('chevD', 14) + '</div></div>' +
      '<div class="field"><label>Subtasks</label><textarea class="input" name="subtasks" rows="3" ' +
        'placeholder="One subtask per line">' + esc(subLines) + '</textarea>' +
        '<div class="hint">' + (isEdit ? 'Replaces the current checklist' : 'Optional checklist') + '</div></div>' +
    '</form>';

  // Re-filter the assignee list when the project changes. An assignee is kept
  // only if they are still a member of the newly chosen project; otherwise the
  // selection resets to "Unassigned".
  const projectSel = body.querySelector('[name="projectId"]');
  const assigneeWrap = body.querySelector('#assignee-field-wrap');
  if (projectSel && assigneeWrap) {
    projectSel.addEventListener('change', () => {
      const cur = assigneeWrap.querySelector('[name="assigneeId"]');
      const curId = cur ? String(cur.value || '') : '';
      const project = projectSel.value ? store.projects.find((p) => p.id === projectSel.value) : null;
      const members = project ? new Set(project.memberIds || []) : null;
      const keepId = (!members || (curId && members.has(curId))) ? curId : '';
      assigneeWrap.innerHTML = '<select class="input" name="assigneeId">' + assigneeOptionsFor(projectSel.value, keepId) + '</select>' + icon('chevD', 14);
    });
  }

  return openModal({
    title: isEdit ? 'Edit task' : 'New task',
    body,
    wide: true,
    okText: isEdit ? 'Save changes' : 'Create task',
    onOk: async () => {
      const form = document.getElementById(formId);
      const data = new FormData(form);
      const title = String(data.get('title') || '').trim();
      if (!title) throw new Error('Task title is required.');
      const startDate = String(data.get('startDate') || '');
      const dueDate = String(data.get('dueDate') || '');
      if (startDate.length && dueDate.length && dueDate < startDate) {
        throw new Error('Due date must be on or after the start date.');
      }

      const payload = {
        title,
        description: String(data.get('description') || '').trim(),
        projectId: data.get('projectId') || null,
        assigneeId: data.get('assigneeId') || null,
        startDate: data.get('startDate') || null,
        dueDate: data.get('dueDate') || null,
        status: isEdit ? data.get('status') : undefined,
        priority: data.get('priority') || 'medium',
        subtasks: String(data.get('subtasks') || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((text) => ({ text })),
      };

      if (isEdit) {
        // Preserve the done-state of subtasks whose text is unchanged.
        const existing = (task.subtasks || []).reduce((acc, s) => { acc[s.text] = s; return acc; }, {});
        payload.subtasks = payload.subtasks.map((s) => {
          const prev = existing[s.text];
          return prev ? { id: prev.id, text: prev.text, done: prev.done } : s;
        });
      }

      let saved;
      if (isEdit) {
        saved = await api.put('/api/tasks/' + task.id, payload);
      } else {
        saved = await api.post('/api/tasks', payload);
      }
      emit('tasks-changed', { });
      toast(isEdit ? 'Task updated.' : 'Task created.');
      if (onSaved) onSaved();
      return saved;
    },
  });
}

// Upload a single file to a task (reused by task detail + comment composer).
export function uploadFileToTask(taskId, file) {
  const fd = new FormData();
  fd.append('taskId', taskId);
  fd.append('file', file);
  return api.upload('/api/upload', fd);
}