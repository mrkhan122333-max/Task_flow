'use strict';

// Validation + shared helpers used across routes and scripts.

const db = require('../db');

const STATUS_ORDER = ['not_started', 'in_progress', 'on_hold', 'completed'];
const ALLOWED_STATUSES = new Set(STATUS_ORDER);

// Display / sort order: most urgent first.
const PRIORITY = ['critical', 'high', 'medium', 'low'];
const PRIORITY_SET = new Set(PRIORITY);
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const ROLES = new Set(['admin', 'employee']);

// Strip control characters and trim. `maxLen` imposes a hard cap.
function cleanString(value, maxLen, options = {}) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  const re = options.allowNewlines
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
    : /[\u0000-\u001F\u007F]/g;
  s = s.replace(re, '').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
function isUsername(value) { return typeof value === 'string' && USERNAME_RE.test(value); }
function isPassword(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 128; }
function isRole(value) { return ROLES.has(value); }
function isStatus(value) { return ALLOWED_STATUSES.has(value); }
function isPriority(value) { return PRIORITY_SET.has(value); }
function isBoolean(value) { return value === true || value === false; }

// A deliberately permissive e-mail check: one "@", a dot in the domain, no
// spaces. The value is never used to build a URL, only displayed and mailed.
const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@,;:<>()[\]\\]+\.[A-Za-z0-9-]{2,}$/;
function cleanEmail(value, maxLen = 120) {
  const email = cleanString(value, maxLen).toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}
function isEmail(value) {
  return typeof value === 'string' && cleanEmail(value) === value.trim().toLowerCase();
}

// Accepts undefined/null/'' → null, or a 'YYYY-MM-DD' string.
function isoDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible calendar dates such as 2026-02-31 (which JS would roll
  // over into March instead of failing).
  if (d.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Overdue engine
//
// A task is Overdue when its due date is strictly in the past AND it is not
// Completed. "Overdue" is a derived flag, never a stored status, so a task
// stops being overdue the moment it is completed — with no data migration.
// ---------------------------------------------------------------------------
function isOverdue(task, today) {
  if (!task || !task.dueDate) return false;
  if (task.status === 'completed') return false;
  return task.dueDate < (today || todayISO());
}

function isDueToday(task, today) {
  if (!task || !task.dueDate) return false;
  // Same "unfinished only" rule as Overdue: a task completed today is not work
  // that is still due, so it must not be highlighted or counted.
  if (task.status === 'completed') return false;
  return task.dueDate === (today || todayISO());
}

// The four canonical statuses a task can hold.
const TASK_STATUSES = STATUS_ORDER;
const TASK_PRIORITIES = PRIORITY;

function validHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// Convert a raw subtask list (from forms) into the stored shape:
// [{ id, text, done }]. Returns null when the field was not supplied at all.
function sanitizeSubtasks(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    const src = item && typeof item === 'object' ? item : { text: item };
    const text = typeof src.text === 'string' ? cleanString(src.text, 200) : '';
    if (!text) continue;
    out.push({
      id: src.id || require('crypto').randomUUID(),
      text,
      done: src.done === true,
    });
  }
  return out.slice(0, 100);
}

// ---------------------------------------------------------------------------
// Access control (server-side, authoritative — the UI never decides this)
// ---------------------------------------------------------------------------

// Project access rule: admins see everything; employees only listed members.
function canAccessProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(project.memberIds) && project.memberIds.includes(user.id);
}

// Task access rule: admins see everything. An employee may reach a task when
// either (a) it is assigned to them, or (b) it belongs to a project they are an
// explicit member of. Everything else is invisible to them.
function canAccessTask(user, task) {
  if (!user || !task) return false;
  if (user.role === 'admin') return true;
  if (task.assigneeId && task.assigneeId === user.id) return true;
  if (task.projectId) {
    const project = db.get('projects', task.projectId);
    if (project && canAccessProject(user, project)) return true;
  }
  return false;
}

// Every task the user is allowed to see (used by /tasks, /search, /stats).
function scopedTaskList(user) {
  const all = db.all('tasks');
  if (user.role === 'admin') return all.slice();
  return all.filter((t) => canAccessTask(user, t));
}

// Only the tasks actually assigned to the user — the "My Tasks" scope, which
// stays narrow even for an admin who is also a member of many projects.
function assignedTaskList(user) {
  return db.filter('tasks', (t) => t.assigneeId === user.id);
}

// Accounts that have been deactivated cannot sign in and lose their sessions.
function isActiveUser(user) {
  return !!user && user.active !== false;
}

// Public shape of a user — never leaks the password hash.
function publicUser(user) {
  if (!user) return null;
  const name = user.displayName || user.username;
  return {
    id: user.id,
    username: user.username,
    // `name` is the canonical label used by the UI; `displayName` is kept for
    // backwards compatibility with any existing client code.
    name,
    displayName: name,
    email: user.email || '',
    department: user.department || '',
    designation: user.designation || '',
    role: user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt || null,
    lastLoginAt: user.lastLoginAt || null,
  };
}

// A compact actor projection for audit entries (never any credential material).
function publicActor(user) {
  if (!user) return { id: null, name: 'System', displayName: 'System', username: null, role: null };
  const name = user.displayName || user.username;
  return {
    id: user.id,
    name,
    displayName: name,
    username: user.username,
    role: user.role,
  };
}

// Simple JSON error responder so every route returns a consistent shape.
function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code: code || 'ERROR' });
}

module.exports = {
  STATUS_ORDER,
  ALLOWED_STATUSES,
  TASK_STATUSES,
  TASK_PRIORITIES,
  PRIORITY,
  PRIORITY_RANK,
  ROLES,
  cleanString,
  cleanEmail,
  isEmail,
  isUsername,
  isPassword,
  isRole,
  isStatus,
  isPriority,
  isBoolean,
  isoDateOnly,
  todayISO,
  isOverdue,
  isDueToday,
  validHexColor,
  sanitizeSubtasks,
  canAccessTask,
  canAccessProject,
  scopedTaskList,
  assignedTaskList,
  isActiveUser,
  publicUser,
  publicActor,
  fail,
};
