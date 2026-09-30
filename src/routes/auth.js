'use strict';

// Authentication: login (with brute-force protection), logout, current user.

const express = require('express');
const db = require('../db');
const config = require('../config');
const { verifyPassword, newToken, sha256 } = require('../lib/crypto');
const { cleanString, publicUser, fail } = require('../lib/validate');
const { authRequired, setSessionCookies, clearSessionCookies } = require('../middleware/auth');

const router = express.Router();
const MAX_FAILED = 8;
const LOCK_MS = 15 * 60 * 1000;

// In-memory brute-force limiter keyed on username|IP.
const attempts = new Map();

function rateKey(username, ip) {
  return `${String(username).toLowerCase()}|${ip || '?'}`;
}

function isLocked(key) {
  const rec = attempts.get(key);
  return !!(rec && rec.lockedUntil > Date.now());
}

function recordFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILED) rec.lockedUntil = now + LOCK_MS;
  attempts.set(key, rec);
  // Keep the map bounded.
  if (attempts.size > 2000) {
    for (const [k, v] of attempts) {
      if (v.lockedUntil < now && v.count < MAX_FAILED) attempts.delete(k);
    }
  }
}

function clearAttempts(key) {
  attempts.delete(key);
}

router.post('/auth/login', (req, res) => {
  const username = cleanString(req.body && req.body.username, 64);
  const password = (req.body && typeof req.body.password === 'string') ? req.body.password : '';

  if (!username || !password) {
    return fail(res, 400, 'Username and password are required.');
  }

  if (db.count('users') === 0) {
    return fail(res, 401, 'No user accounts exist yet. Run `npm run seed` to create the first admin.', 'NO_USERS');
  }

  const key = rateKey(username, req.ip);
  if (isLocked(key)) {
    return fail(res, 429, 'Too many failed attempts. Please try again in a few minutes.', 'RATE_LIMITED');
  }

  const user = db.find('users', (u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.passwordHash)) {
    recordFailure(key);
    return fail(res, 401, 'Invalid username or password.');
  }

  // All good — create a session and issue cookies.
  const sidToken = newToken();
  const csrfToken = newToken();
  db.insert('sessions', {
    tokenHash: sha256(sidToken),
    userId: user.id,
    createdAt: db.now(),
    expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString(),
  });
  setSessionCookies(res, sidToken, csrfToken);
  clearAttempts(key);
  return res.json({ user: publicUser(user) });
});

router.post('/auth/logout', authRequired, (req, res) => {
  db.remove('sessions', req.session.id);
  clearSessionCookies(res);
  return res.json({ ok: true });
});

router.get('/auth/me', authRequired, (req, res) => {
  return res.json({ user: publicUser(req.user) });
});

module.exports = router;