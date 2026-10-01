'use strict';

// Global search: tasks (role-scoped), projects and people.

const express = require('express');
const db = require('../db');
const {
  cleanString, scopedTaskList, canAccessProject, publicUser, todayISO, isOverdue,
} = require('../lib/validate');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Every haystack is coerced: a legacy row with a missing field must not throw
// and take the whole search down.
const hay = (value) => String(value === null || value === undefined ? '' : value).toLowerCase();

router.get('/search', authRequired, (req, res) => {
  const q = cleanString(req.query && req.query.q, 100).toLowerCase();
  if (q.length < 2) return res.json({ tasks: [], projects: [], users: [] });

  const today = todayISO();

  const tasks = scopedTaskList(req.user)
    .filter((t) => hay(t.title).includes(q) || hay(t.description).includes(q))
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      overdue: isOverdue(t, today),
    }));

  const projects = db.filter('projects', (p) =>
      canAccessProject(req.user, p) &&
      (hay(p.name).includes(q) || hay(p.description).includes(q)))
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, color: p.color }));

  const users = db.filter('users', (u) =>
      hay(u.username).includes(q) ||
      hay(u.displayName).includes(q) ||
      hay(u.department).includes(q) ||
      hay(u.designation).includes(q))
    .slice(0, 5)
    .map(publicUser);

  return res.json({ tasks, projects, users });
});

module.exports = router;