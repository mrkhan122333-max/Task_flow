'use strict';

// Append-only task audit trail.
//
// Every entry is written once and is never modified. Entries are only removed
// when the task they belong to is deleted, so the history of a live task is
// always complete and in chronological order.
//
// Entry shape:
//   { id, taskId, actorId, type, field, from, to, meta, createdAt }
//
// type   — created | assigned | status | priority | due_date | start_date |
//          project | title | description | subtask | comment | file
// field  — the task property the entry is about (null for `created`)
// from   — previous value (null when there was none)
// to     — new value
// meta   — free-form, JSON-safe extra context (never a password or hash)

const db = require('../db');
const { publicActor } = require('./validate');

const EVENT = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  STATUS: 'status',
  PRIORITY: 'priority',
  DUE_DATE: 'due_date',
  START_DATE: 'start_date',
  PROJECT: 'project',
  TITLE: 'title',
  DESCRIPTION: 'description',
  SUBTASK: 'subtask',
  COMMENT: 'comment',
  FILE: 'file',
};

const FIELD_FOR_TYPE = {
  [EVENT.ASSIGNED]: 'assigneeId',
  [EVENT.STATUS]: 'status',
  [EVENT.PRIORITY]: 'priority',
  [EVENT.DUE_DATE]: 'dueDate',
  [EVENT.START_DATE]: 'startDate',
  [EVENT.PROJECT]: 'projectId',
  [EVENT.TITLE]: 'title',
  [EVENT.DESCRIPTION]: 'description',
};

function valueOrNull(value) {
  if (value === undefined || value === '' || value === null) return null;
  return typeof value === 'string' ? value.slice(0, 200) : value;
}

// The single write path. Returns the stored entry.
function append(taskId, actorId, type, options = {}) {
  if (!taskId) return null;
  return db.insert('activity', {
    taskId,
    actorId: actorId || null,
    type,
    field: options.field !== undefined ? options.field : (FIELD_FOR_TYPE[type] || null),
    from: valueOrNull(options.from),
    to: valueOrNull(options.to),
    meta: options.meta && typeof options.meta === 'object' ? options.meta : null,
  });
}

// ---------------------------------------------------------------------------
// Convenience wrappers used by the routes
// ---------------------------------------------------------------------------

// "Alice created this task" — also captures the initial state of the task so
// the first timeline entry is self-describing.
function logCreated(task, actorId) {
  return append(task.id, actorId, EVENT.CREATED, {
    field: null,
    meta: {
      title: task.title,
      status: task.status,
      priority: task.priority || 'medium',
      assigneeId: task.assigneeId || null,
      projectId: task.projectId || null,
      startDate: task.startDate || null,
      dueDate: task.dueDate || null,
    },
  });
}

function logStatusChange(task, from, to, actorId, completedAt) {
  const meta = (to === 'completed' && completedAt) ? { completedAt } : null;
  return append(task.id, actorId, EVENT.STATUS, { from, to, meta });
}

function logAssignment(task, from, to, actorId) {
  return append(task.id, actorId, EVENT.ASSIGNED, { from, to });
}

function logFieldChange(task, type, from, to, actorId) {
  // Skip no-op writes so the trail only records real changes.
  const a = valueOrNull(from);
  const b = valueOrNull(to);
  if (a === b) return null;
  return append(task.id, actorId, type, { from: a, to: b });
}

function logComment(task, comment, actorId) {
  const excerpt = String(comment.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return append(task.id, actorId, EVENT.COMMENT, {
    field: null,
    meta: { commentId: comment.id, excerpt },
  });
}

function logFile(task, file, actorId) {
  return append(task.id, actorId, EVENT.FILE, {
    field: null,
    meta: { fileId: file.id, name: file.originalName, size: file.size, ext: file.ext },
  });
}

// Only called when the task itself is deleted.
function purgeForTask(taskId) {
  db.replace('activity', db.all('activity').filter((a) => a.taskId !== taskId));
}

// Raw entries, oldest first.
function entriesForTask(taskId) {
  return db.filter('activity', (a) => a.taskId === taskId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Entries enriched with the actor's public projection, ready for the API.
function timelineForTask(taskId) {
  const usersById = new Map(db.all('users').map((u) => [u.id, u]));
  return entriesForTask(taskId).map((entry) => Object.assign({}, entry, {
    actor: publicActor(usersById.get(entry.actorId)),
  }));
}

module.exports = {
  EVENT,
  append,
  logCreated,
  logStatusChange,
  logAssignment,
  logFieldChange,
  logComment,
  logFile,
  entriesForTask,
  timelineForTask,
  purgeForTask,
};
