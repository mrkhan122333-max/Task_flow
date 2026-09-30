'use strict';

// Validation + shared helpers used across routes and scripts.

const db = require('../db');

const STATUS_ORDER = ['not_started', 'in_progress', 'on_hold', 'completed'];
const ALLOWED_STATUSES = new Set(STATUS_ORDER);
const PRIORITY = ['low', 'medium', 'high'];
const PRIORITY_SET = new Set(PRIORITY);
const ROLES = new Set(['admin', 'analyst']);

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

// Accepts undefined/null/'' → null, or a 'YYYY-MM-DD' string.
function isoDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : value;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

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

// Task access rule: admins see everything; analysts only their own assigned tasks.
function canAccessTask(user, task) {
  if (!user || !task) return false;
  if (user.role === 'admin') return true;
  return task.assigneeId === user.id;
}

// Project access rule: admins see everything; analysts only listed members.
function canAccessProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(project.memberIds) && project.memberIds.includes(user.id);
}

// The task list an analyst is allowed to see (used by /tasks and /search).
function scopedTaskList(user) {
  const all = db.all('tasks');
  if (user.role === 'admin') return all.slice();
  return all.filter((t) => t.assigneeId === user.id);
}

// Public shape of a user — never leaks the password hash.
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    createdAt: user.createdAt,
  };
}

// Simple JSON error responder so every route returns a consistent shape.
function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code: code || 'ERROR' });
}

module.exports = {
  STATUS_ORDER,
  ALLOWED_STATUSES,
  PRIORITY,
  cleanString,
  isUsername,
  isPassword,
  isRole,
  isStatus,
  isPriority,
  isBoolean,
  isoDateOnly,
  todayISO,
  validHexColor,
  sanitizeSubtasks,
  canAccessTask,
  canAccessProject,
  scopedTaskList,
  publicUser,
  fail,
};