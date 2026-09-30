// Task detail — slide-out drawer with status, meta, subtasks, attachments and
// a threaded comment stream. Available to the assignee or admins.

import { api, uploadFile } from '../api.js';
import { store, userById, emit } from '../store.js';
import {
  icon, avatar, toast, openModal, confirmModal, statusOptions, taskFormModal,
  projectInfo,
} from '../components.js';
import {
  esc, fmtDate, timeAgo, fmtSize, fileAccent, fileLabel, isOverdue, STATUS_META,
  PRIORITY_META,
} from '../util.js';

let currentTaskId = null;
let drawerOpen = false;
let built = false;
let drawerEl = null;
let overlayEl = null;
let bodyEl = null;

function ensureBuilt() {
  if (built) return;
  built = true;
  const root = document.getElementById('drawer-root');
  root.innerHTML =
    '<div class="drawer-overlay" id="drawer-overlay" hidden></div>' +
    '<aside class="drawer" id="drawer" aria-hidden="true">' +
      '<div class="drawer-head" id="drawer-head"></div>' +
      '<div class="drawer-body" id="drawer-body"></div>' +
    '</aside>';
  overlayEl = document.getElementById('drawer-overlay');
  drawerEl = document.getElementById('drawer');
  bodyEl = document.getElementById('drawer-body');

  overlayEl.addEventListener('click', closeTask);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) closeTask();
  });
  drawerEl.addEventListener('click', (e) => {
    // clicking inside is fine
    e.stopPropagation();
  });
}

export function isOpen() { return drawerOpen; }

export function openTask(taskId) {
  ensureBuilt();
  currentTaskId = taskId;
  drawerOpen = true;
  overlayEl.hidden = false;
  drawerEl.setAttribute('aria-hidden', 'false');
  // next frame so the transition plays
  requestAnimationFrame(() => drawerEl.classList.add('open'));
  load();
}

export function closeTask() {
  if (!drawerOpen) return;
  drawerOpen = false;
  currentTaskId = null;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  setTimeout(() => { overlayEl.hidden = true; }, 220);
}

// ---------- loading ----------
async function load() {
  const head = document.getElementById('drawer-head');
  bodyEl.innerHTML = '<div class="spinner"></div>';
  head.innerHTML = '<div style="flex:1;min-width:0">' +
      '<div class="drawer-title">Loading…</div>' +
    '</div>' +
    '<button type="button" class="icon-btn" id="drawer-x">' + icon('x', 18) + '</button>';
  document.getElementById('drawer-x').addEventListener('click', closeTask);

  if (!currentTaskId) return;
  try {
    const [taskRes, commentsRes, filesRes] = await Promise.all([
      api.get('/api/tasks/' + currentTaskId),
      api.get('/api/tasks/' + currentTaskId + '/comments'),
      api.get('/api/tasks/' + currentTaskId + '/files'),
    ]);
    const task = taskRes.task;
    task._comments = commentsRes.comments;
    task._files = filesRes.files;
    render(task);
  } catch (err) {
    if (err.status === 404) {
      head.innerHTML = '<div style="flex:1"><div class="drawer-title">Task not found</div>' +
        '<div class="drawer-meta">It may have been deleted.</div></div>' +
        '<button type="button" class="icon-btn" id="drawer-x2">' + icon('x', 18) + '</button>';
      bodyEl.innerHTML = '<div class="empty-state">' + icon('alert', 28) + '</div>';
      document.getElementById('drawer-x2').addEventListener('click', closeTask);
      return;
    }
    toast(err.message || 'Could not load task.', 'error');
    closeTask();
  }
}

// ---------- render ----------
function render(task) {
  const head = document.getElementById('drawer-head');
  const isAdmin = store.user.role === 'admin';
  const meta = STATUS_META[task.status] || STATUS_META.not_started;

  const assignee = task.assigneeId ? userById(task.assigneeId) : null;
  const project = task.projectId ? projectInfo(task) : null;
  const overdue = isOverdue(task);
  const pmeta = PRIORITY_META[(task && task.priority) || 'medium'] || PRIORITY_META.medium;

  head.innerHTML =
    '<div style="flex:1;min-width:0">' +
      '<div class="inline-flex" style="gap:10px;flex-wrap:wrap">' +
        '<span class="status-pill" style="display:inline-flex;align-items:center;gap:8px;border:1px solid var(--c-border-strong);border-radius:999px;padding:4px 6px 4px 12px;background:' + meta.bg + '">' +
          '<span style="color:' + meta.color + ';font-weight:700;font-size:13px">' + esc(meta.label) + '</span>' +
          (isAdmin || task.assigneeId === store.user.id
            ? '<button type="button" class="icon-btn change-status-btn" title="Change status" style="width:24px;height:24px">' + icon('chevD', 15) + '</button>'
            : '') +
        '</span>' +
        '<span class="badge" style="background:' + pmeta.bg + ';color:' + pmeta.color + '" title="Priority">' +
          '<span class="dot"></span>' + esc(pmeta.label) + '</span>' +
        (overdue
          ? '<span class="badge badge-red">' + icon('alert', 13) + ' Overdue · was due ' + esc(fmtDate(task.dueDate)) + '</span>'
          : '') +
      '</div>' +
      '<div class="drawer-meta">' +
        esc('Created ' + timeAgo(task.createdAt)) +
        (task.updatedAt ? ' · updated ' + timeAgo(task.updatedAt) : '') +
      '</div>' +
    '</div>' +
    '<div class="inline-flex" style="gap:4px">' +
      (isAdmin
        ? '<button type="button" class="icon-btn" id="edit-task" title="Edit task">' + icon('pen', 17) + '</button>'
        : '') +
      (isAdmin
        ? '<button type="button" class="icon-btn" id="del-task" title="Delete task" style="color:var(--c-red)">' + icon('trash', 17) + '</button>'
        : '') +
      '<button type="button" class="icon-btn" id="drawer-x" title="Close">' + icon('x', 18) + '</button>' +
    '</div>';

  document.getElementById('drawer-x').addEventListener('click', closeTask);

  // Status change UI: open a small modal with the status options.
  const changeBtn = head.querySelector('.change-status-btn');
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      openModal({
        title: 'Change status',
        body: '<div class="field"><label>Status</label><div class="select-wrap"><select class="input" id="status-choose">' +
          statusOptions(task.status) + '</select>' + icon('chevD', 14) + '</div></div>',
        okText: 'Update status',
        onOk: async () => {
          const status = document.getElementById('status-choose').value;
          if (status === task.status) return false;
          const upd = await api.put('/api/tasks/' + task.id + '/status', { status });
          task.status = upd.task.status;
          task.updatedAt = upd.task.updatedAt;
          emit('task-updated', { id: task.id });
          toast('Status updated to ' + STATUS_META[status].label + '.');
          render(task);
          return true;
        },
      });
    });
  }

  const editBtn = head.querySelector('#edit-task');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      taskFormModal(task, {}, () => { if (drawerOpen && currentTaskId) load(); });
    });
  }
  const delBtn = head.querySelector('#del-task');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const ok = await confirmModal('Delete "' + task.title + '"? All subtasks, comments and attachments will be removed.');
      if (!ok) return;
      try {
        await api.del('/api/tasks/' + task.id);
        closeTask();
        emit('tasks-changed', {});
        toast('Task deleted.');
      } catch (err) {
        toast(err.message || 'Could not delete task.', 'error');
      }
    });
  }

  // ---- body ----
  const subs = task.subtasks || [];
  const subDone = subs.filter((s) => s.done).length;
  const subPct = subs.length ? Math.round((subDone / subs.length) * 100) : 0;

  bodyEl.innerHTML =
    '<div class="drawer-title">' + esc(task.title) + '</div>' +
    '<p class="desc-blob" style="margin-top:10px">' + (task.description ? esc(task.description) : '<span class="muted">No description provided.</span>') + '</p>' +

    '<div class="detail-grid">' +
      '<div class="detail-box"><div class="dlabel">Assignee</div><div class="dval">' + (assignee ? avatar(assignee, 22) + ' ' + esc(assignee.displayName || assignee.username) : '<span class="muted">Unassigned</span>') + '</div></div>' +
      '<div class="detail-box"><div class="dlabel">Start date</div><div class="dval">' + (task.startDate ? icon('clock', 15) + ' ' + esc(fmtDate(task.startDate)) : '<span class="muted">Not set</span>') + '</div></div>' +
      '<div class="detail-box"><div class="dlabel">Due date</div><div class="dval"' + (overdue ? ' style="color:var(--c-red)"' : '') + '>' + (task.dueDate ? icon('calendar', 15) + ' ' + esc(fmtDate(task.dueDate)) : '<span class="muted">Not set</span>') + '</div></div>' +
      '<div class="detail-box"><div class="dlabel">Project</div><div class="dval">' + (project ? '<span class="proj-chip"><span class="dot" style="background:' + esc(project.color) + '"></span>' + esc(project.name) + '</span>' : '<span class="muted">—</span>') + '</div></div>' +
    '</div>' +

    sectionHeader('Subtasks', subs.length ? '<span class="badge badge-muted">' + subDone + '/' + subs.length + '</span>' : '') +
    '<div class="flex-between" style="margin-bottom:6px">' +
      '<div class="sub-progress" style="max-width:200px"><span style="width:' + subPct + '%"></span></div>' +
      '<span class="muted" style="font-size:12px">' + subPct + '%</span>' +
    '</div>' +
    (subs.length
      ? '<div class="checklist">' + subs.map((s) => checklistRow(task, s, isAdmin)).join('') + '</div>'
      : '<p class="muted" style="font-size:13px">' + (isAdmin ? 'Add subtasks below.' : 'No subtasks yet.') + '</p>') +
    (isAdmin
      ? '<div class="sub-add-row">' +
          '<input type="text" id="sub-add-input" class="input" placeholder="Add a subtask and press Enter…" maxlength="200">' +
          '<button type="button" class="btn btn-primary btn-sm" id="sub-add-btn">' + icon('plus', 14) + ' Add</button>' +
        '</div>'
      : '') +

    '<hr class="divider">' +
    sectionHeader('Attachments', '<button type="button" class="btn btn-ghost btn-sm" id="add-file">' + icon('paperclip', 14) + ' Attach</button>') +
    '<div class="attach-list" id="file-list">' + renderFiles(task, task._files) + '</div>' +

    '<hr class="divider">' +
    '<h3 class="section-title">' + esc('Comments ') + '<span class="badge badge-muted">' + (task._comments ? task._comments.length : 0) + '</span></h3>' +
    '<div class="comment-thread" id="comment-thread">' + renderComments(task, task._comments) + '</div>' +
    '<div class="composer">' +
      '<textarea id="comment-text" placeholder="Write a comment…"></textarea>' +
      '<div class="composer-foot">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="comment-attach">' + icon('paperclip', 14) + ' Attach file</button>' +
        '<span id="comment-attach-name"></span>' +
        '<button type="button" class="btn btn-primary btn-sm" id="comment-post" style="margin-left:auto">' + icon('send', 14) + ' Comment</button>' +
      '</div>' +
    '</div>' +
    '<input type="file" id="file-input" hidden>' +
    '<input type="file" id="comment-file-input" hidden>';

  const fileInput = bodyEl.querySelector('#file-input');
  const addFile = bodyEl.querySelector('#add-file');
  addFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const res = await uploadFile('/api/upload', { taskId: task.id, file });
      task._files = [res.file].concat(task._files || []);
      emit('task-updated', { id: task.id });
      bodyEl.querySelector('#file-list').outerHTML = '<div class="attach-list" id="file-list">' + renderFiles(task, task._files) + '</div>';
      rebindFiles(task);
      toast('File attached.');
    } catch (err) {
      toast(err.message || 'Upload failed.', 'error');
    } finally {
      fileInput.value = '';
    }
  });

  // Comment composer
  let pendingCommentFile = null;
  const cText = bodyEl.querySelector('#comment-text');
  const cName = bodyEl.querySelector('#comment-attach-name');
  const cAttach = bodyEl.querySelector('#comment-attach');
  const cFileInput = bodyEl.querySelector('#comment-file-input');
  cAttach.addEventListener('click', () => cFileInput.click());
  cFileInput.addEventListener('change', async () => {
    const file = cFileInput.files && cFileInput.files[0];
    if (!file) return;
    try {
      const res = await uploadFile('/api/upload', { taskId: task.id, file });
      pendingCommentFile = res.file;
      cName.textContent = 'Attached: ' + pendingCommentFile.originalName;
      cName.classList.add('composer-attach-pre');
    } catch (err) {
      toast(err.message || 'Upload failed.', 'error');
    } finally {
      cFileInput.value = '';
    }
  });

  const postComment = async () => {
    const text = cText.value.trim();
    if (!text && !pendingCommentFile) {
      toast('Write a comment first.', 'info');
      return;
    }
    try {
      const payload = { taskId: task.id, text };
      if (pendingCommentFile) payload.fileId = pendingCommentFile.id;
      await api.post('/api/comments', payload);
      const commentsRes = await api.get('/api/tasks/' + task.id + '/comments');
      const filesRes = await api.get('/api/tasks/' + task.id + '/files');
      task._comments = commentsRes.comments;
      task._files = filesRes.files;
      cText.value = '';
      pendingCommentFile = null;
      cName.textContent = '';
      cName.classList.remove('composer-attach-pre');
      emit('task-updated', { id: task.id });
      bodyEl.querySelector('#comment-thread').outerHTML =
        '<div class="comment-thread" id="comment-thread">' + renderComments(task, task._comments) + '</div>';
      rebindComments(task);
    } catch (err) {
      toast(err.message || 'Could not post comment.', 'error');
    }
  };
  bodyEl.querySelector('#comment-post').addEventListener('click', postComment);
  cText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      postComment();
    }
  });

  rebindComments(task);
  rebindFiles(task);
  rebindChecklist(task);
  bindAddSubtask(task);
}

// Admin quick-add for a single subtask inside the drawer.
function bindAddSubtask(task) {
  const input = bodyEl.querySelector('#sub-add-input');
  if (!input) return;
  const addBtn = bodyEl.querySelector('#sub-add-btn');
  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      const upd = await api.post('/api/tasks/' + task.id + '/subtasks', { text });
      task.subtasks = upd.task.subtasks;
      task.updatedAt = upd.task.updatedAt;
      input.value = '';
      emit('task-updated', { id: task.id });
      render(task);
    } catch (err) {
      toast(err.message || 'Could not add subtask.', 'error');
    }
  };
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
}

function sectionHeader(label, extra) {
  return '<div class="flex-between" style="margin-bottom:10px"><h3 class="section-title" style="margin:0">' + esc(label) + '</h3>' + (extra || '') + '</div>';
}

function checklistRow(task, sub, canManage) {
  return '<div class="check-row' + (sub.done ? ' done' : '') + '" data-sub-id="' + esc(sub.id) + '">' +
    '<input type="checkbox"' + (sub.done ? ' checked' : '') + '>' +
    '<span class="check-text">' + esc(sub.text) + '</span>' +
    (canManage
      ? '<button type="button" class="icon-btn" title="Remove" style="width:26px;height:26px">' + icon('x', 13) + '</button>'
      : '') +
  '</div>';
}

function renderFiles(task, files) {
  const commentFileIds = new Set((task._comments || []).map((c) => c.fileId).filter(Boolean));
  const list = (files || []).filter((f) => !commentFileIds.has(f.id));
  if (!list.length) return '<p class="muted" style="font-size:13px">No attachments yet.</p>';
  return list.map((f) => {
    const isImage = f.kind === 'image';
    const preview = isImage
      ? '<img class="attach-preview" src="' + esc(f.url) + '" alt="' + esc(f.originalName) + '" loading="lazy">'
      : '';
    const deletable = store.user.role === 'admin' || f.uploadedById === store.user.id;
    return '<div class="attach-wrap" data-file-id="' + esc(f.id) + '">' +
      '<div class="attach-item">' +
        '<span class="attach-ic" style="background:' + fileAccent(f.ext) + '">' + icon('file', 16) + '</span>' +
        '<span style="flex:1;min-width:0"><div class="attach-name" title="' + esc(f.originalName) + '">' + esc(f.originalName) + '</div>' +
        '<div class="attach-meta">' + esc(fileLabel(f.ext)) + ' · ' + fmtSize(f.size) + '</div></span>' +
        '<div class="attach-actions">' +
          '<a class="icon-btn" href="' + esc(f.url) + '" download title="Download">' + icon('download', 16) + '</a>' +
          (deletable ? '<button type="button" class="icon-btn" data-del-file style="color:var(--c-red)" title="Delete">' + icon('trash', 16) + '</button>' : '') +
        '</div>' +
      '</div>' + preview +
    '</div>';
  }).join('');
}

function renderComments(task, comments) {
  const list = comments || [];
  if (!list.length) {
    return '<p class="muted" style="font-size:13px">No comments yet.</p>';
  }
  return list.map((c) => {
    const author = userById(c.userId) || { id: c.userId, displayName: 'Removed user', username: 'removed' };
    const isMine = c.userId === store.user.id;
    const deletable = store.user.role === 'admin' || isMine;
    const att = c.fileId ? task._files.find((f) => f.id === c.fileId) : null;
    return '<div class="comment" data-comment-id="' + esc(c.id) + '">' +
      avatar(author, 28) +
      '<div class="comment-body">' +
        '<div class="comment-head"><strong>' + esc(author.displayName || author.username) + '</strong><time>' + timeAgo(c.createdAt) + '</time></div>' +
        '<div class="comment-bubble">' +
          '<div class="c-text">' + esc(c.text) + '</div>' +
          (att
            ? '<a class="comment-attach" href="' + esc(att.url) + '" download>' +
                icon('file', 14) + esc(att.originalName) + ' · ' + fmtSize(att.size) + '</a>'
            : '') +
        '</div>' +
        (deletable
          ? '<button type="button" class="icon-btn comment-del" data-del-comment style="width:26px;height:26px;margin-top:4px" title="Delete comment">' + icon('trash', 14) + '</button>'
          : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ---------- event rebinding (re-attached after innerHTML swaps) ----------
function rebindChecklist(task) {
  bodyEl.querySelectorAll('.check-row').forEach((row) => {
    const subId = row.getAttribute('data-sub-id');
    const cb = row.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', async () => {
      try {
        const upd = await api.put('/api/tasks/' + task.id + '/subtasks/' + subId, { done: cb.checked });
        task.subtasks = upd.task.subtasks;
        task.updatedAt = upd.task.updatedAt;
        emit('task-updated', { id: task.id });
        render(task);
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message || 'Could not update subtask.', 'error');
      }
    });
    const remove = row.querySelector('button');
    if (remove) {
      remove.addEventListener('click', async () => {
        const ok = await confirmModal('Remove this subtask?');
        if (!ok) return;
        try {
          const upd = await api.put('/api/tasks/' + task.id, { subtasks: task.subtasks.filter((s) => s.id !== subId) });
          task.subtasks = upd.task.subtasks;
          emit('task-updated', { id: task.id });
          render(task);
        } catch (err) {
          toast(err.message || 'Could not remove subtask.', 'error');
        }
      });
    }
  });
}

function rebindFiles(task) {
  bodyEl.querySelectorAll('[data-del-file]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-file-id]').getAttribute('data-file-id');
      const ok = await confirmModal('Remove this attachment?');
      if (!ok) return;
      try {
        await api.del('/api/files/' + id);
        task._files = (task._files || []).filter((f) => f.id !== id);
        emit('task-updated', { id: task.id });
        bodyEl.querySelector('#file-list').outerHTML = '<div class="attach-list" id="file-list">' + renderFiles(task, task._files) + '</div>';
        rebindFiles(task);
      } catch (err) {
        toast(err.message || 'Could not delete file.', 'error');
      }
    });
  });
}

function rebindComments(task) {
  bodyEl.querySelectorAll('[data-del-comment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-comment-id]').getAttribute('data-comment-id');
      const ok = await confirmModal('Delete this comment?');
      if (!ok) return;
      try {
        await api.del('/api/comments/' + id);
        task._comments = (task._comments || []).filter((c) => c.id !== id);
        emit('task-updated', { id: task.id });
        bodyEl.querySelector('#comment-thread').outerHTML =
          '<div class="comment-thread" id="comment-thread">' + renderComments(task, task._comments) + '</div>';
        rebindComments(task);
      } catch (err) {
        toast(err.message || 'Could not delete comment.', 'error');
      }
    });
  });
}