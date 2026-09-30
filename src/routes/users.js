'use strict';

// Admin user management (create / edit / delete accounts).

const express = require('express');
const db = require('../db');
const { hashPassword } = require('../lib/crypto');
const {
  cleanString, isUsername, isPassword, isRole, publicUser, fail,
} = require('../lib/validate');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

// The full list is needed by the message UI for everyone, but it only exposes
// the safe public shape (no password hashes).
router.get('/users', authRequired, (req, res) => {
  const users = db.all('users')
    .slice()
    .sort((a, b) => {
      if (a.role === b.role) return a.username.localeCompare(b.username);
      return a.role === 'admin' ? -1 : 1;
    })
    .map(publicUser);
  return res.json({ users });
});

router.post('/users', authRequired, adminOnly, (req, res) => {
  const username = cleanString(req.body && req.body.username, 64);
  const password = req.body && req.body.password;
  const role = req.body && req.body.role;
  let displayName = cleanString(req.body && req.body.displayName, 60);

  if (!isUsername(username)) {
    return fail(res, 400, 'Username must be 3–32 characters and may contain letters, numbers, ".", "_" or "-".');
  }
  if (!isPassword(password)) {
    return fail(res, 400, 'Password must be between 8 and 128 characters.');
  }
  if (!isRole(role)) {
    return fail(res, 400, 'Role must be "admin" or "analyst".');
  }
  if (!displayName) displayName = username;
  if (typeof displayName !== 'string' || displayName.length > 60) {
    return fail(res, 400, 'Display name is too long (max 60 characters).');
  }

  if (db.find('users', (u) => u.username.toLowerCase() === username.toLowerCase())) {
    return fail(res, 409, 'That username is already taken.');
  }

  const user = db.insert('users', {
    username,
    displayName,
    role,
    passwordHash: hashPassword(password),
  });
  return res.status(201).json({ user: publicUser(user) });
});

router.put('/users/:id', authRequired, adminOnly, (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return fail(res, 404, 'User not found.');

  const body = req.body || {};
  const patch = {};

  if (body.hasOwnProperty('username')) {
    const username = cleanString(body.username, 64);
    if (!isUsername(username)) {
      return fail(res, 400, 'Username must be 3–32 characters and may contain letters, numbers, ".", "_" or "-".');
    }
    if (db.find('users', (u) => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase())) {
      return fail(res, 409, 'That username is already taken.');
    }
    patch.username = username;
  }

  if (body.hasOwnProperty('displayName')) {
    const dn = cleanString(body.displayName, 60);
    patch.displayName = dn || patch.username || user.username;
  }

  if (body.hasOwnProperty('role')) {
    if (!isRole(body.role)) return fail(res, 400, 'Role must be "admin" or "analyst".');
    patch.role = body.role;
  }

  if (body.hasOwnProperty('password')) {
    const pw = body.password == null ? '' : String(body.password);
    if (pw) {
      if (!isPassword(pw)) return fail(res, 400, 'Password must be between 8 and 128 characters.');
      patch.passwordHash = hashPassword(pw);
    }
  }

  if (Object.keys(patch).length === 0) {
    return fail(res, 400, 'No changes provided.');
  }

  patch.updatedAt = db.now();
  const updated = db.update('users', user.id, patch);
  return res.json({ user: publicUser(updated) });
});

router.delete('/users/:id', authRequired, adminOnly, (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return fail(res, 404, 'User not found.');
  if (String(user.id) === String(req.user.id)) {
    return fail(res, 400, 'You cannot delete your own account.');
  }

  // Cascade: drop sessions and unassign tasks. Messages and comments are
  // kept (shown as "removed user").
  db.replace('sessions', db.all('sessions').filter((s) => s.userId !== user.id));
  db.replace('tasks', db.all('tasks').map((t) => (
    t.assigneeId === user.id ? { ...t, assigneeId: null, updatedAt: db.now() } : t
  )));
  db.remove('users', user.id);
  return res.json({ ok: true });
});

module.exports = router;