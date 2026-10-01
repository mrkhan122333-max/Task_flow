'use strict';

// Tasks: listing/filtering, admin CRUD, assignee status + subtask updates.
//
// Every task carries a read-only projection computed here (overdue, dueToday,
// project label) so every client — and the dashboard metrics — agree on the
// same derived state. Every mutation appends to the task's audit trail.

const express = require('express');
const db = require('../db');
const activity = require('../lib/activity');
const {
  cleanString, isStatus, isPriority, isBoolean, isoDateOnly, todayISO,
  isOverdue, isDueToday, PRIORITY_RANK, sanitizeSubtasks, canAccessTask,
  scopedTaskList, fail,
} = require('../lib/validate');
const { authRequired, adminOnly } = require('../middleware/auth');
const { requireTaskAccess, requireTaskWrite } = require('../middleware/rbac');
const { deleteFileRecord } = require('./files');

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(iso, days) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

// Adds the derived, read-only fields every consumer needs.
function augmentTask(task, today) {
  if (!task) return task;
  const project = task.projectId ? db.get('projects', task.projectId) : null;
  return Object.assign({}, task, {
    // Derived on every read: a task is Overdue while its due date is in the
    // past and its status is not Completed.
    overdue: isOverdue(task, today),
    dueToday: isDueToday(task, today),
    // The project chip renders from this read-only projection so a member of
    // the project can see its name/colour without a second lookup.
    projectName: project ? project.name : null,
    projectColor: project ? project.color : null,
  });
}

function augmentTasks(tasks) {
  if (!tasks.length) return tasks;
  const today = todayISO();
  const commentCounts = {};
  const fileCounts = {};
  for (const c of db.all('comments')) commentCounts[c.taskId] = (commentCounts[c.taskId] || 0) + 1;
  for (const f of db.all('files')) if (!f.commentId) fileCounts[f.taskId] = (fileCounts[f.taskId] || 0) + 1;
  return tasks.map((t) => {
    const aug = augmentTask(t, today);
    aug.commentCount = commentCounts[t.id] || 0;
    aug.filesCount = fileCounts[t.id] || 0;
    return aug;
  });
}

// A task date is optional; when supplied it must be a real YYYY-MM-DD value.
function parseDateField(value, label) {
  if (value === null || value === undefined || value === '') return { value: null };
  const iso = isoDateOnly(value);
  if (!iso) return { error: label + ' must be a valid date in YYYY-MM-DD format.' };
  return { value: iso };
}

// The due date may never fall before the start date.
function dateRangeError(startDate, dueDate) {
  if (startDate && dueDate && dueDate < startDate) {
    return 'Due date must be on or after the start date.';
  }
  return null;
}

// The create/edit form submits subtasks as plain text lines, which would drop
// each subtask's id/done flags on every edit. When a line's text already exists
// in the stored checklist, inherit its original id and done state. Callers that
// explicitly send an id or a done flag keep full control instead.
function preserveSubtaskState(incoming, existing) {
  if (!Array.isArray(incoming)) return incoming;
  if (!Array.isArray(existing) || !existing.length) return incoming;
  const byText = new Map(existing.map((s) => [s.text, s]));
  return incoming.map((item) => {
    const src = item && typeof item === 'object' ? item : { text: item };
    if (src.id || typeof src.text !== 'string') return src;
    if (Object.prototype.hasOwnProperty.call(src, 'done')) return src;
    const prev = byText.get(src.text.trim());
    return prev ? { id: prev.id, text: src.text, done: prev.done } : src;
  });
}

// An assignee must be an employee listed in the project's memberIds — unless
// they are an admin (admins always have access to every project).
function isProjectAssignee(projectId, userId) {
  const project = db.get('projects', projectId);
  const user = db.get('users', userId);
  if (user && user.role === 'admin') return true;
  return Array.isArray(project && project.memberIds) && project.memberIds.includes(userId);
}

// True when a submitted value would leave the stored field exactly as it is, so
// the caller can treat it as a no-op. Subtasks are compared field by field
// instead of by JSON, because key order and legacy shapes are not guaranteed.
function sameStoredValue(field, next, current) {
  if (field === 'subtasks') {
    const a = Array.isArray(next) ? next : [];
    const b = Array.isArray(current) ? current : [];
    if (a.length !== b.length) return false;
    return a.every((sub, i) => {
      const other = b[i] || {};
      return !!sub.id === !!other.id && (!sub.id || sub.id === other.id) &&
        sub.text === other.text && !!sub.done === !!other.done;
    });
  }
  if (next === current) return true;
  // Legacy rows can be missing the key entirely while a form submits an empty
  // value for it; null and '' both mean "nothing recorded".
  const emptyish = (v) => v === null || v === undefined || v === '';
  return emptyish(next) && emptyish(current);
}

// db.update() mutates and returns the very same row object that db.get()
// handed back, so every value needed for the audit trail has to be snapshotted
// BEFORE the write. Without this, a change would be logged as "x → x".
function snapshot(task) {
  return {
    title: task.title,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId === undefined ? null : task.assigneeId,
    projectId: task.projectId === undefined ? null : task.projectId,
    startDate: task.startDate === undefined ? null : task.startDate,
    dueDate: task.dueDate === undefined ? null : task.dueDate,
    subtasks: (task.subtasks || []).slice(),
  };
}

// ---------------------------------------------------------------------------
// Due-date filtering
// ---------------------------------------------------------------------------
// `due` accepts a preset or is combined with explicit from/to bounds:
//   ''        no due-date constraint
//   overdue   due before today and not completed
//   today     due today and not completed
//   week      due between today and today+7 and not completed
//   next7     due between today+1 and today+7 and not completed
//   month     due between today+1 and today+30 and not completed
//   none      no due date at all
//   range     dueFrom .. dueTo (inclusive), each optional
//
// Every preset except `none` and `range` looks only at unfinished work: a
// completed task is never "due", whatever its due date says.
function applyDueFilter(tasks, q, today) {
  const preset = String(q.due || '').trim();
  const from = isoDateOnly(q.dueFrom);
  const to = isoDateOnly(q.dueTo);

  if (preset === 'none') return tasks.filter((t) => !t.dueDate);
  if (preset === 'overdue') return tasks.filter((t) => isOverdue(t, today));
  if (preset === 'today') return tasks.filter((t) => isDueToday(t, today));
  if (preset === 'week') {
    const end = addDays(today, 7);
    return tasks.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= end && t.status !== 'completed');
  }
  if (preset === 'next7') {
    const start = addDays(today, 1);
    const end = addDays(today, 7);
    return tasks.filter((t) => t.dueDate && t.dueDate >= start && t.dueDate <= end && t.status !== 'completed');
  }
  if (preset === 'month') {
    const start = addDays(today, 1);
    const end = addDays(today, 30);
    return tasks.filter((t) => t.dueDate && t.dueDate >= start && t.dueDate <= end && t.status !== 'completed');
  }
  if (from || to) {
    return tasks.filter((t) => {
      if (!t.dueDate) return false;
      if (from && t.dueDate < from) return false;
      if (to && t.dueDate > to) return false;
      return true;
    });
  }
  return tasks;
}

function sortTasks(tasks, sort) {
  tasks.sort((a, b) => {
    const aTime = a.updatedAt || a.createdAt || '';
    const bTime = b.updatedAt || b.createdAt || '';
    if (sort === 'due') {
      if (!a.dueDate && !b.dueDate) return bTime.localeCompare(aTime);
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
    if (sort === 'priority') {
      // Critical → High → Medium → Low, then most recently updated first.
      const pa = PRIORITY_RANK[a.priority] === undefined ? PRIORITY_RANK.medium : PRIORITY_RANK[a.priority];
      const pb = PRIORITY_RANK[b.priority] === undefined ? PRIORITY_RANK.medium : PRIORITY_RANK[b.priority];
      if (pa !== pb) return pa - pb;
      return bTime.localeCompare(aTime);
    }
    if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
    return bTime.localeCompare(aTime);
  });
  return tasks;
}

// GET /api/tasks — employees are auto-scoped by the RBAC rule (their own
// assignments plus the projects they are a member of).
router.get('/tasks', authRequired, (req, res) => {
  const q = req.query || {};
  const today = todayISO();
  let tasks = scopedTaskList(req.user);

  if (q.status && isStatus(q.status)) tasks = tasks.filter((t) => t.status === q.status);
  if (q.priority && isPriority(q.priority)) tasks = tasks.filter((t) => t.priority === q.priority);
  if (q.projectId) tasks = tasks.filter((t) => t.projectId === q.projectId);
  // Safe for every role: the list is already scoped, so an employee can only
  // ever narrow their own visible set.
  if (q.assigneeId) tasks = tasks.filter((t) => t.assigneeId === q.assigneeId);
  if (q.overdue === '1') tasks = tasks.filter((t) => isOverdue(t, today));
  if (q.due || q.dueFrom || q.dueTo) tasks = applyDueFilter(tasks, q, today);
  if (q.search) {
    const s = String(q.search).toLowerCase();
    tasks = tasks.filter((t) =>
      String(t.title || '').toLowerCase().includes(s) ||
      String(t.description || '').toLowerCase().includes(s));
  }

  return res.json({ tasks: augmentTasks(sortTasks(tasks, q.sort || 'updated')) });
});

// GET /api/tasks/:id
router.get('/tasks/:id', authRequired, requireTaskAccess(), (req, res) => {
  return res.json({ task: augmentTasks([req.task])[0] });
});

// POST /api/tasks — admin only.
router.post('/tasks', authRequired, adminOnly, (req, res) => {
  const body = req.body || {};
  const title = cleanString(body.title, 200);
  if (!title) return fail(res, 400, 'Task title is required.');
  const description = cleanString(body.description, 5000, { allowNewlines: true });

  let assigneeId = body.assigneeId ? String(body.assigneeId) : null;
  if (assigneeId && !db.get('users', assigneeId)) {
    return fail(res, 400, 'Selected assignee does not exist.');
  }
  let projectId = body.projectId ? String(body.projectId) : null;
  if (projectId && !db.get('projects', projectId)) {
    return fail(res, 400, 'Selected project does not exist.');
  }
  if (assigneeId && projectId && !isProjectAssignee(projectId, assigneeId)) {
    return fail(res, 400, 'Selected assignee is not a member of this project.');
  }
  const startDate = parseDateField(body.startDate, 'Start date');
  if (startDate.error) return fail(res, 400, startDate.error);
  const dueDate = parseDateField(body.dueDate, 'Due date');
  if (dueDate.error) return fail(res, 400, dueDate.error);
  const rangeError = dateRangeError(startDate.value, dueDate.value);
  if (rangeError) return fail(res, 400, rangeError);
  const status = isStatus(body.status) ? body.status : 'not_started';
  const priorityValue = body.priority === undefined || body.priority === null || body.priority === ''
    ? 'medium'
    : body.priority;
  if (!isPriority(priorityValue)) {
    return fail(res, 400, 'Invalid priority. Use one of: low, medium, high, critical.');
  }
  const subtasks = sanitizeSubtasks(body.subtasks) || [];

  const now = db.now();
  const task = db.insert('tasks', {
    title,
    description,
    status,
    priority: priorityValue,
    assigneeId,
    projectId,
    startDate: startDate.value,
    dueDate: dueDate.value,
    completedAt: status === 'completed' ? now : null,
    subtasks,
    createdById: req.user.id,
    createdAt: now,
    updatedAt: now,
  });
  // "Alice created this task" is the first entry of the audit trail.
  activity.logCreated(task, req.user.id);
  return res.status(201).json({ task: augmentTasks([task])[0] });
});

// PUT /api/tasks/:id — admin full edit.
router.put('/tasks/:id', authRequired, adminOnly, requireTaskAccess(), (req, res) => {
  const task = req.task;
  const body = req.body || {};
  const patch = {};

  if (body.hasOwnProperty('title')) {
    const title = cleanString(body.title, 200);
    if (!title) return fail(res, 400, 'Task title is required.');
    patch.title = title;
  }
  if (body.hasOwnProperty('description')) {
    patch.description = cleanString(body.description, 5000, { allowNewlines: true });
  }
  if (body.hasOwnProperty('status')) {
    if (!isStatus(body.status)) return fail(res, 400, 'Invalid status.');
    patch.status = body.status;
  }
  if (body.hasOwnProperty('priority')) {
    if (!isPriority(body.priority)) {
      return fail(res, 400, 'Invalid priority. Use one of: low, medium, high, critical.');
    }
    patch.priority = body.priority;
  }
  if (body.hasOwnProperty('assigneeId')) {
    const assigneeId = body.assigneeId ? String(body.assigneeId) : null;
    if (assigneeId && !db.get('users', assigneeId)) {
      return fail(res, 400, 'Selected assignee does not exist.');
    }
    patch.assigneeId = assigneeId;
  }
  if (body.hasOwnProperty('projectId')) {
    const projectId = body.projectId ? String(body.projectId) : null;
    if (projectId && !db.get('projects', projectId)) {
      return fail(res, 400, 'Selected project does not exist.');
    }
    patch.projectId = projectId;
  }
  // Validate the resulting pairing whenever the request touches the project or
  // the assignee, so a devtools/API call cannot pair an assignee with a project
  // they are not a member of (admins are exempt).
  if (body.hasOwnProperty('projectId') || body.hasOwnProperty('assigneeId')) {
    const nextProjectId = body.hasOwnProperty('projectId') ? patch.projectId : task.projectId;
    const nextAssigneeId = body.hasOwnProperty('assigneeId') ? patch.assigneeId : task.assigneeId;
    if (nextProjectId && nextAssigneeId && !isProjectAssignee(nextProjectId, nextAssigneeId)) {
      return fail(res, 400, 'Selected assignee is not a member of this project.');
    }
  }
  let nextStart = task.startDate;
  if (body.hasOwnProperty('startDate')) {
    const parsed = parseDateField(body.startDate, 'Start date');
    if (parsed.error) return fail(res, 400, parsed.error);
    nextStart = parsed.value;
    patch.startDate = parsed.value;
  }
  let nextDue = task.dueDate;
  if (body.hasOwnProperty('dueDate')) {
    const parsed = parseDateField(body.dueDate, 'Due date');
    if (parsed.error) return fail(res, 400, parsed.error);
    nextDue = parsed.value;
    patch.dueDate = parsed.value;
  }
  const rangeError = dateRangeError(nextStart, nextDue);
  if (rangeError) return fail(res, 400, rangeError);
  if (body.hasOwnProperty('subtasks')) {
    patch.subtasks = sanitizeSubtasks(preserveSubtaskState(body.subtasks, task.subtasks)) || [];
  }

  // The edit form always submits every field, so re-saving an unchanged task
  // would otherwise bump `updatedAt`, refresh `completedAt` and append a trail
  // of "changed X from X to X" entries. Drop any field whose value is identical
  // to what is already stored. Nothing left means the save was a no-op, which is
  // reported as success (the form submits every field on every save) rather than
  // as an error.
  for (const key of Object.keys(patch)) {
    if (!sameStoredValue(key, patch[key], task[key])) continue;
    delete patch[key];
  }
  if (Object.keys(patch).length === 0) {
    return res.json({ task: augmentTasks([task])[0], unchanged: true });
  }

  // Keep the completion timestamp consistent with the status, but only when the
  // status actually moved — resubmitting a completed task must not re-stamp it.
  const now = db.now();
  const before = snapshot(task);
  if (patch.hasOwnProperty('status')) {
    if (patch.status === 'completed') patch.completedAt = now;
    else if (task.status === 'completed') patch.completedAt = null;
  }

  patch.updatedAt = now;
  const updated = db.update('tasks', task.id, patch);

  // --- audit trail ---------------------------------------------------------
  // Each entry is logged from the surviving patch keys, so an unchanged field
  // never produces a redundant entry.
  if (patch.hasOwnProperty('status')) {
    activity.logStatusChange(updated, before.status, patch.status, req.user.id, patch.completedAt || null);
  }
  if (patch.hasOwnProperty('assigneeId')) {
    activity.logAssignment(updated, before.assigneeId, patch.assigneeId, req.user.id);
  }
  if (patch.hasOwnProperty('dueDate')) {
    activity.logFieldChange(updated, activity.EVENT.DUE_DATE, before.dueDate, patch.dueDate, req.user.id);
  }
  if (patch.hasOwnProperty('startDate')) {
    activity.logFieldChange(updated, activity.EVENT.START_DATE, before.startDate, patch.startDate, req.user.id);
  }
  if (patch.hasOwnProperty('priority')) {
    activity.logFieldChange(updated, activity.EVENT.PRIORITY, before.priority, patch.priority, req.user.id);
  }
  if (patch.hasOwnProperty('projectId')) {
    activity.logFieldChange(updated, activity.EVENT.PROJECT, before.projectId, patch.projectId, req.user.id);
  }
  if (patch.hasOwnProperty('title')) {
    activity.logFieldChange(updated, activity.EVENT.TITLE, before.title, patch.title, req.user.id);
  }
  if (patch.hasOwnProperty('description')) {
    activity.logFieldChange(updated, activity.EVENT.DESCRIPTION, null, 'updated', req.user.id);
  }
  // The checklist is replaced wholesale by the edit form, so log the individual
  // additions and removals rather than a single opaque write.
  if (patch.hasOwnProperty('subtasks')) {
    const beforeIds = new Set(before.subtasks.map((s) => s.id));
    const afterIds = new Set(patch.subtasks.map((s) => s.id));
    for (const sub of patch.subtasks) {
      if (!beforeIds.has(sub.id)) {
        activity.append(updated.id, req.user.id, activity.EVENT.SUBTASK, {
          field: 'subtasks', from: null, to: sub.text, meta: { subtaskId: sub.id, added: true },
        });
      }
    }
    for (const sub of before.subtasks) {
      if (!afterIds.has(sub.id)) {
        activity.append(updated.id, req.user.id, activity.EVENT.SUBTASK, {
          field: 'subtasks', from: sub.text, to: null, meta: { subtaskId: sub.id, removed: true },
        });
      }
    }
  }

  return res.json({ task: augmentTasks([updated])[0] });
});

// PUT /api/tasks/:id/status — assignee (or admin) may change the status.
router.put('/tasks/:id/status', authRequired, requireTaskWrite(), (req, res) => {
  const task = req.task;
  const status = req.body && req.body.status;
  if (!isStatus(status)) {
    return fail(res, 400, 'Invalid status. Use one of: not_started, in_progress, on_hold, completed.');
  }
  if (status === task.status) {
    return res.json({ task: augmentTasks([task])[0], unchanged: true });
  }

  const now = db.now();
  const before = snapshot(task);
  const patch = { status, updatedAt: now };
  // A task that is moved to "In Progress" with no start date records today as
  // the day it actually started.
  if (status === 'in_progress' && !before.startDate) patch.startDate = todayISO();
  // Completion timestamp, and its mirror image when a task is reopened.
  if (status === 'completed') patch.completedAt = now;
  else if (before.status === 'completed') patch.completedAt = null;

  const updated = db.update('tasks', task.id, patch);
  activity.logStatusChange(updated, before.status, status, req.user.id, patch.completedAt || null);
  if (patch.startDate) {
    activity.logFieldChange(updated, activity.EVENT.START_DATE, before.startDate, patch.startDate, req.user.id);
  }
  return res.json({ task: augmentTasks([updated])[0] });
});

// POST /api/tasks/:id/subtasks — admin-only quick add of one subtask.
router.post('/tasks/:id/subtasks', authRequired, adminOnly, requireTaskAccess(), (req, res) => {
  const task = req.task;
  const text = cleanString(req.body && req.body.text, 200);
  if (!text) return fail(res, 400, 'Subtask text is required.');
  const existing = task.subtasks || [];
  if (existing.length >= 100) return fail(res, 400, 'A task can have at most 100 subtasks.');
  const added = sanitizeSubtasks([{ text }]);
  const updated = db.update('tasks', task.id, {
    subtasks: existing.concat(added),
    updatedAt: db.now(),
  });
  for (const sub of added) {
    activity.append(task.id, req.user.id, activity.EVENT.SUBTASK, {
      field: 'subtasks',
      from: null,
      to: sub.text,
      meta: { subtaskId: sub.id, added: true },
    });
  }
  return res.json({ task: augmentTasks([updated])[0] });
});

// PUT /api/tasks/:id/subtasks/:subId — toggle a subtask checkbox.
router.put('/tasks/:id/subtasks/:subId', authRequired, requireTaskWrite(), (req, res) => {
  const task = req.task;
  const done = req.body && req.body.done;
  if (!isBoolean(done)) return fail(res, 400, '"done" must be true or false.');
  const target = (task.subtasks || []).find((s) => s.id === req.params.subId);
  if (!target) return fail(res, 404, 'Subtask not found.');
  // Re-checking an already-checked box writes nothing and logs nothing.
  if (target.done === done) {
    return res.json({ task: augmentTasks([task])[0], unchanged: true });
  }
  const subtasks = (task.subtasks || []).map((s) => (s.id === req.params.subId ? Object.assign({}, s, { done }) : s));
  const updated = db.update('tasks', task.id, { subtasks, updatedAt: db.now() });
  activity.append(task.id, req.user.id, activity.EVENT.SUBTASK, {
    field: 'subtasks',
    from: target.done ? 'done' : 'open',
    to: done ? 'done' : 'open',
    meta: { subtaskId: target.id, text: target.text },
  });
  return res.json({ task: augmentTasks([updated])[0] });
});

// DELETE /api/tasks/:id — admin only. Cascades to comments + attachments +
// the task's audit trail.
router.delete('/tasks/:id', authRequired, adminOnly, requireTaskAccess(), (req, res) => {
  const task = req.task;

  for (const comment of db.filter('comments', (c) => c.taskId === task.id)) {
    if (comment.fileId) deleteFileRecord(db.get('files', comment.fileId));
    db.remove('comments', comment.id);
  }
  for (const file of db.filter('files', (f) => f.taskId === task.id && !f.commentId)) {
    deleteFileRecord(file);
  }
  activity.purgeForTask(task.id);
  db.remove('tasks', task.id);
  return res.json({ ok: true });
});

// Re-exported so other route modules can apply exactly the same rule.
module.exports = router;
module.exports.canAccessTask = canAccessTask;
