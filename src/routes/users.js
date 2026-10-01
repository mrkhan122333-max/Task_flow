'use strict';

// User management (admin only) — create, edit, deactivate/reactivate and reset
// passwords for Employees and Admins.
//
// The employee profile is: Name, Email, Department, Designation, Role.
// `username` stays as the sign-in handle, and `active` gates whether the
// account may sign in at all.

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { hashPassword } = require('../lib/crypto');
const {
  cleanString, cleanEmail, isUsername, isPassword, isRole, isBoolean,
  publicUser, fail,
} = require('../lib/validate');
const { authRequired, adminOnly } = require('../middleware/auth');
const mailer = require('../lib/mailer');

const router = express.Router();

const DEPARTMENTS = [
  'Engineering', 'Design', 'Product', 'Marketing', 'Sales', 'Support',
  'Human Resources', 'Finance', 'Operations', 'Quality Assurance', 'Other',
];

function readProfile(body, user) {
  // Returns { patch, error }. Only fields present in the request are patched,
  // so a partial update never wipes a value the caller did not send.
  const patch = {};

  if (body.hasOwnProperty('displayName') || body.hasOwnProperty('name')) {
    const raw = body.hasOwnProperty('name') ? body.name : body.displayName;
    const name = cleanString(raw, 80);
    if (!name) return { error: 'Name is required.' };
    patch.displayName = name;
  }

  if (body.hasOwnProperty('email')) {
    const email = cleanString(body.email, 120).toLowerCase();
    if (email && !cleanEmail(email)) {
      return { error: 'Please enter a valid e-mail address.' };
    }
    if (email) {
      const taken = db.find('users', (u) => (u.email || '').toLowerCase() === email
        && (!user || u.id !== user.id));
      if (taken) return { error: 'That e-mail address is already in use by another account.' };
    }
    patch.email = email;
  }

  if (body.hasOwnProperty('department')) {
    patch.department = cleanString(body.department, 60);
  }

  if (body.hasOwnProperty('designation')) {
    patch.designation = cleanString(body.designation, 60);
  }

  return { patch };
}

// Never leave the installation without a way in.
function activeAdminCount(excludeUserId) {
  return db.count('users', (u) => u.role === 'admin'
    && u.active !== false
    && (!excludeUserId || u.id !== excludeUserId));
}

function assertNotLastActiveAdmin(user, action) {
  if (user.role !== 'admin' || user.active === false) return;
  if (activeAdminCount(user.id) === 0) {
    return 'This is the last active administrator — ' + action +
      ' it would lock everyone out of user management.';
  }
  return null;
}

// Readable but high-entropy temporary password, handed to the admin once and
// e-mailed to the account owner.
function generatePassword() {
  return 'Cosmic-' + crypto.randomBytes(12).toString('base64url');
}

// Drop every session belonging to a user (used on deactivate and reset).
// `keepSessionId` preserves the caller's own session so an admin who changes
// their own password is not bounced to the sign-in screen mid-request.
function destroySessions(userId, keepSessionId) {
  const kept = keepSessionId ? String(keepSessionId) : null;
  const next = db.all('sessions').filter((s) => (
    s.userId !== userId || (kept && String(s.id) === kept)
  ));
  if (next.length !== db.all('sessions').length) db.replace('sessions', next);
}

// The full list is needed by the message UI and the task filters for everyone,
// but it only exposes the safe public shape (no password hashes).
router.get('/users', authRequired, (req, res) => {
  const users = db.all('users')
    .slice()
    .sort((a, b) => {
      const an = a.displayName || a.username || '';
      const bn = b.displayName || b.username || '';
      if (a.role === b.role) return String(an).localeCompare(String(bn));
      return a.role === 'admin' ? -1 : 1;
    })
    .map(publicUser);
  return res.json({ users });
});

// GET /api/users/departments — the fixed list offered by the admin form.
router.get('/users/departments', authRequired, (req, res) => {
  return res.json({ departments: DEPARTMENTS });
});

router.post('/users', authRequired, adminOnly, (req, res) => {
  const body = req.body || {};
  const username = cleanString(body.username, 64);
  const password = typeof body.password === 'string' ? body.password : '';
  const role = body.role;

  if (!isUsername(username)) {
    return fail(res, 400, 'Username must be 3–32 characters and may contain letters, numbers, ".", "_" or "-".');
  }
  if (!isPassword(password)) {
    return fail(res, 400, 'Password must be between 8 and 128 characters.');
  }
  if (!isRole(role)) {
    return fail(res, 400, 'Role must be "admin" or "employee".');
  }
  if (db.find('users', (u) => String(u.username || '').toLowerCase() === username.toLowerCase())) {
    return fail(res, 409, 'That username is already taken.');
  }

  const profile = readProfile(Object.assign({ displayName: username }, body), null);
  if (profile.error) return fail(res, 400, profile.error);

  const user = db.insert('users', Object.assign({
    username,
    role,
    active: true,
    passwordHash: hashPassword(password),
  }, profile.patch));

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
    if (db.find('users', (u) => u.id !== user.id && String(u.username || '').toLowerCase() === username.toLowerCase())) {
      return fail(res, 409, 'That username is already taken.');
    }
    patch.username = username;
  }

  const profile = readProfile(body, user);
  if (profile.error) return fail(res, 400, profile.error);
  Object.assign(patch, profile.patch);

  if (body.hasOwnProperty('role')) {
    if (!isRole(body.role)) return fail(res, 400, 'Role must be "admin" or "employee".');
    if (body.role !== user.role) {
      const guard = assertNotLastActiveAdmin(user, 'you cannot change their role to "' + body.role + '" because');
      if (guard) return fail(res, 409, guard);
    }
    patch.role = body.role;
  }

  if (body.hasOwnProperty('active')) {
    if (!isBoolean(body.active)) return fail(res, 400, '"active" must be true or false.');
    if (!body.active && body.active !== user.active) {
      const guard = assertNotLastActiveAdmin(user, 'you cannot deactivate it because');
      if (guard) return fail(res, 409, guard);
    }
    patch.active = body.active;
  }

  if (body.hasOwnProperty('password')) {
    const pw = body.password == null ? '' : String(body.password);
    if (pw) {
      if (!isPassword(pw)) return fail(res, 400, 'Password must be between 8 and 128 characters.');
      patch.passwordHash = hashPassword(pw);
      // A new password invalidates every existing session for that account.
      patch.sessionsInvalidated = true;
    }
  }

  if (Object.keys(patch).length === 0) {
    return fail(res, 400, 'No changes provided.');
  }

  const invalidated = patch.sessionsInvalidated === true;
  delete patch.sessionsInvalidated;

  patch.updatedAt = db.now();
  const updated = db.update('users', user.id, patch);
  const isSelf = String(req.user.id) === String(user.id);
  if (invalidated) destroySessions(user.id, isSelf ? req.session.id : null);

  return res.json({
    user: publicUser(updated),
    sessionsInvalidated: invalidated && !isSelf,
    self: isSelf,
  });
});

// POST /api/users/:id/active — deactivate (or reactivate) an account.
router.post('/users/:id/active', authRequired, adminOnly, (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return fail(res, 404, 'User not found.');

  const active = req.body && req.body.active;
  if (!isBoolean(active)) return fail(res, 400, '"active" must be true or false.');

  if (String(user.id) === String(req.user.id) && !active) {
    return fail(res, 400, 'You cannot deactivate your own account.');
  }
  if (!active) {
    const guard = assertNotLastActiveAdmin(user, 'you cannot deactivate it because');
    if (guard) return fail(res, 409, guard);
  }
  if (user.active === active) {
    return res.json({ user: publicUser(user), unchanged: true });
  }

  const updated = db.update('users', user.id, { active, updatedAt: db.now() });
  // Deactivation takes effect at once: every live session is destroyed so the
  // account is locked out even with a cookie already in the browser.
  if (!active) destroySessions(user.id);
  return res.json({ user: publicUser(updated) });
});

// POST /api/users/:id/reset-password — admin resets an employee's password.
// The temporary password is returned ONCE to the admin (there is no way to
// recover it later) and, when SMTP is configured, e-mailed to the account.
router.post('/users/:id/reset-password', authRequired, adminOnly, async (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return fail(res, 404, 'User not found.');

  const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (supplied && !isPassword(supplied)) {
    return fail(res, 400, 'Password must be between 8 and 128 characters.');
  }
  const password = supplied || generatePassword();
  const isSelf = String(req.user.id) === String(user.id);

  db.update('users', user.id, { passwordHash: hashPassword(password), updatedAt: db.now() });
  // Signing the actor out of their *own* reset would be a pointless trapdoor,
  // so the current session survives and only other sessions are dropped.
  destroySessions(user.id, isSelf ? req.session.id : null);

  let emailed = false;
  if (user.email) {
    emailed = await mailer.sendPasswordResetNotice({
      to: user.email,
      name: user.displayName,
      username: user.username,
      password: password,
      resetBy: req.user.displayName || req.user.username,
    });
  }

  return res.json({
    ok: true,
    user: publicUser(db.get('users', user.id)),
    // Shown once in the admin UI so it can be handed over in person. Never
    // stored in plain text and never logged.
    temporaryPassword: password,
    emailed,
    emailDelivered: emailed,
    // A self-reset keeps the current session alive, so the browser does not
    // need to sign in again.
    self: isSelf,
    emailNotice: emailed
      ? 'A password-reset e-mail was sent to ' + user.email + '.'
      : (user.email
        ? 'The e-mail could not be sent — share the temporary password securely instead.'
        : 'This account has no e-mail address on file — share the temporary password securely.'),
  });
});

router.delete('/users/:id', authRequired, adminOnly, (req, res) => {
  const user = db.get('users', req.params.id);
  if (!user) return fail(res, 404, 'User not found.');
  if (String(user.id) === String(req.user.id)) {
    return fail(res, 400, 'You cannot delete your own account.');
  }
  const guard = assertNotLastActiveAdmin(user, 'you cannot delete it because');
  if (guard) return fail(res, 409, guard);

  // Cascade: drop sessions and unassign tasks. Messages and comments are
  // kept (shown as "removed user").
  destroySessions(user.id);
  db.replace('tasks', db.all('tasks').map((t) => (
    t.assigneeId === user.id ? { ...t, assigneeId: null, updatedAt: db.now() } : t
  )));
  db.remove('users', user.id);
  return res.json({ ok: true });
});

module.exports = router;
module.exports.DEPARTMENTS = DEPARTMENTS;
