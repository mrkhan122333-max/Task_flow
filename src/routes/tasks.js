'use strict';

// Tasks: listing/filtering, admin CRUD, analyst status + subtask updates.

const express = require('express');
const db = require('../db');
const {
  cleanString, isStatus, isPriority, isBoolean, isoDateOnly, todayISO,
  sanitizeSubtasks, canAccessTask, scopedTaskList, fail,
} = require('../lib/validate');
const { authRequired, adminOnly } = require('../middleware/auth');
const { deleteFileRecord } = require('./files');

const router = express.Router();

function augmentTasks(tasks) {
  if (!tasks.length) return tasks;
  const commentCounts = {};
  const fileCounts = {};
  const projectsById = new Map(db.all('projects').map((p) => [p.id, p]));
  for (const c of db.all('comments')) commentCounts[c.taskId] = (commentCounts[c.taskId] || 0) + 1;
  for (const f of db.all('files')) if (!f.commentId) fileCounts[f.taskId] = (fileCounts[f.taskId] || 0) + 1;
  return tasks.map((t) => {
    const project = projectsById.get(t.projectId) || null;
    return Object.assign({}, t, {
      commentCount: commentCounts[t.id] || 0,
      filesCount: fileCounts[t.id] || 0,
      // The project chip renders from this read-only projection so an analyst
      // can see the name/color of a task's project even if they are not a
      // member of that project (see projects.js membership scoping).
      projectName: project ? project.name : null,
      projectColor: project ? project.color : null,
    });
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

// An assignee must be an analyst listed in the project's memberIds — unless
// they are an admin (admins always have access to every project).
function isProjectAssignee(projectId, userId) {
  const project = db.get('projects', projectId);
  const user = db.get('users', userId);
  if (user && user.role === 'admin') return true;
  return Array.isArray(project && project.memberIds) && project.memberIds.includes(userId);
}

// GET /api/tasks — analysts are auto-scoped to their own assignments.
router.get('/tasks', authRequired, (req, res) => {
  const q = req.query || {};
  let tasks = scopedTaskList(req.user);

  if (q.status && isStatus(q.status)) tasks = tasks.filter((t) => t.status === q.status);
  if (q.priority && isPriority(q.priority)) tasks = tasks.filter((t) => t.priority === q.priority);
  if (q.projectId) tasks = tasks.filter((t) => t.projectId === q.projectId);
  if (q.assigneeId && req.user.role === 'admin') tasks = tasks.filter((t) => t.assigneeId === q.assigneeId);
  if (q.overdue === '1') {
    tasks = tasks.filter((t) => t.dueDate && t.dueDate < todayISO() && t.status !== 'completed');
  }
  if (q.search) {
    const s = String(q.search).toLowerCase();
    tasks = tasks.filter((t) =>
      t.title.toLowerCase().includes(s) || (t.description || '').toLowerCase().includes(s));
  }

  const sort = q.sort || 'updated';
  tasks.sort((a, b) => {
    if (sort === 'due') {
      if (!a.dueDate && !b.dueDate) return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
    if (sort === 'priority') {
      // High → Medium → Low, with missing priority treated as Medium.
      const order = { high: 0, medium: 1, low: 2 };
      const pa = order[a.priority || 'medium'];
      const pb = order[b.priority || 'medium'];
      if (pa !== pb) return pa - pb;
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
    }
    return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
  });

  return res.json({ tasks: augmentTasks(tasks) });
});

// GET /api/tasks/:id
router.get('/tasks/:id', authRequired, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task || !canAccessTask(req.user, task)) return fail(res, 404, 'Task not found.');
  return res.json({ task: augmentTasks([task])[0] });
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
    return fail(res, 400, 'Invalid priority. Use one of: low, medium, high.');
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
    subtasks,
    createdById: req.user.id,
    createdAt: now,
    updatedAt: now,
  });
  return res.status(201).json({ task });
});

// PUT /api/tasks/:id — admin full edit.
router.put('/tasks/:id', authRequired, adminOnly, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task) return fail(res, 404, 'Task not found.');
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
      return fail(res, 400, 'Invalid priority. Use one of: low, medium, high.');
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

  if (Object.keys(patch).length === 0) {
    return fail(res, 400, 'No changes provided.');
  }
  patch.updatedAt = db.now();
  const updated = db.update('tasks', task.id, patch);
  return res.json({ task: augmentTasks([updated])[0] });
});

// PUT /api/tasks/:id/status — assignee (or admin) may change the status.
router.put('/tasks/:id/status', authRequired, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task || !canAccessTask(req.user, task)) return fail(res, 404, 'Task not found.');
  const status = req.body && req.body.status;
  if (!isStatus(status)) {
    return fail(res, 400, 'Invalid status. Use one of: not_started, in_progress, on_hold, completed.');
  }
  const patch = { status, updatedAt: db.now() };
  // A task that is moved to "In Progress" with no start date records today as
  // the day it actually started.
  if (status === 'in_progress' && !task.startDate) patch.startDate = todayISO();
  const updated = db.update('tasks', task.id, patch);
  return res.json({ task: augmentTasks([updated])[0] });
});

// POST /api/tasks/:id/subtasks — admin-only quick add of one subtask.
router.post('/tasks/:id/subtasks', authRequired, adminOnly, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task) return fail(res, 404, 'Task not found.');
  const text = cleanString(req.body && req.body.text, 200);
  if (!text) return fail(res, 400, 'Subtask text is required.');
  const existing = task.subtasks || [];
  if (existing.length >= 100) return fail(res, 400, 'A task can have at most 100 subtasks.');
  const added = sanitizeSubtasks([{ text }]);
  const updated = db.update('tasks', task.id, {
    subtasks: existing.concat(added),
    updatedAt: db.now(),
  });
  return res.json({ task: augmentTasks([updated])[0] });
});

// PUT /api/tasks/:id/subtasks/:subId — toggle a subtask checkbox.
router.put('/tasks/:id/subtasks/:subId', authRequired, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task || !canAccessTask(req.user, task)) return fail(res, 404, 'Task not found.');
  const done = req.body && req.body.done;
  if (!isBoolean(done)) return fail(res, 400, '"done" must be true or false.');
  const subtasks = task.subtasks.map((s) => (s.id === req.params.subId ? Object.assign({}, s, { done }) : s));
  const updated = db.update('tasks', task.id, { subtasks, updatedAt: db.now() });
  return res.json({ task: augmentTasks([updated])[0] });
});

// DELETE /api/tasks/:id — admin only. Cascades to comments + attachments.
router.delete('/tasks/:id', authRequired, adminOnly, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task) return fail(res, 404, 'Task not found.');

  for (const comment of db.filter('comments', (c) => c.taskId === task.id)) {
    if (comment.fileId) deleteFileRecord(db.get('files', comment.fileId));
    db.remove('comments', comment.id);
  }
  for (const file of db.filter('files', (f) => f.taskId === task.id && !f.commentId)) {
    deleteFileRecord(file);
  }
  db.remove('tasks', task.id);
  return res.json({ ok: true });
});

module.exports = router;