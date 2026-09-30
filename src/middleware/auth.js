'use strict';

// Authentication, role and CSRF middleware.
//
// Sessions are stored server-side (token hash only) in the JSON database. The
// browser only ever holds a random token in an httpOnly cookie. A second,
// JavaScript-readable cookie carries a CSRF token that every state-changing
// request echoes back in the X-CSRF-Token header.

const db = require('../db');
const config = require('../config');
const { sha256, safeEqual } = require('../lib/crypto');

const SESSION_COOKIE = 'taskflow_sid';
const CSRF_COOKIE = 'taskflow_csrf';

// Endpoints that are exempt from the CSRF check (mounted under the API base).
const CSRF_SKIP = new Set(['/auth/login']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch (err) { /* keep raw */ }
    if (key) out[key] = value;
  }
  return out;
}

function cookieOptions(maxAgeSeconds) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: config.cookiePath,
  };
  if (maxAgeSeconds) options.maxAge = maxAgeSeconds * 1000;
  return options;
}

function setSessionCookies(res, sidToken, csrfToken) {
  res.cookie(SESSION_COOKIE, sidToken, cookieOptions(config.sessionTtlSeconds));
  res.cookie(CSRF_COOKIE, csrfToken, {
    ...cookieOptions(config.sessionTtlSeconds),
    httpOnly: false, // the browser needs to read it to send the header
  });
}

function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: config.cookiePath });
  res.clearCookie(CSRF_COOKIE, { path: config.cookiePath });
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || null;
}

function authRequired(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
  }
  const tokenHash = sha256(token);
  const session = db.find('sessions', (s) => s.tokenHash === tokenHash);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
    if (session) db.remove('sessions', session.id);
    return res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'UNAUTHORIZED' });
  }
  const user = db.get('users', session.userId);
  if (!user) {
    db.remove('sessions', session.id);
    return res.status(401).json({ error: 'Your account no longer exists.', code: 'UNAUTHORIZED' });
  }
  req.session = session;
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.', code: 'FORBIDDEN' });
  }
  next();
}

function csrfProtect(req, res, next) {
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
  if (CSRF_SKIP.has(req.path)) return next();
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token') || '';
  if (!cookieToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({
      error: 'Invalid or missing security token. Please refresh the page and try again.',
      code: 'CSRF',
    });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  parseCookies,
  setSessionCookies,
  clearSessionCookies,
  getSessionToken,
  authRequired,
  adminOnly,
  csrfProtect,
};