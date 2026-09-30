'use strict';

// Global search: tasks (role-scoped), projects and people.

const express = require('express');
const db = require('../db');
const { cleanString, scopedTaskList, canAccessProject, publicUser } = require('../lib/validate');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/search', authRequired, (req, res) => {
  const q = cleanString(req.query && req.query.q, 100).toLowerCase();
  if (q.length < 2) return res.json({ tasks: [], projects: [], users: [] });

  const tasks = scopedTaskList(req.user)
    .filter((t) => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
    .slice(0, 8)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.dueDate }));

  const projects = db.filter('projects', (p) =>
      canAccessProject(req.user, p) &&
      (p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)))
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, color: p.color }));

  const users = db.filter('users', (u) =>
    u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))
    .slice(0, 5)
    .map(publicUser);

  return res.json({ tasks, projects, users });
});

module.exports = router;