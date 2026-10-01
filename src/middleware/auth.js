'use strict';

// Authentication, role and CSRF middleware.
//
// Sessions are stored server-side (token hash only) in the JSON database. The
// browser only ever holds a random token in an httpOnly cookie. A second,
// JavaScript-readable cookie carries a CSRF token that every state-changing
// request echoes back in the X-CSRF-Token header.
//
// The stored token digest is an HMAC keyed with SESSION_SECRET rather than a
// bare SHA-256, so a leaked data file alone is not enough to forge a session.

const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sha256, safeEqual } = require('../lib/crypto');
const { isActiveUser } = require('../lib/validate');

const SESSION_COOKIE = 'cosmic_sid';
const CSRF_COOKIE = 'cosmic_csrf';

// Endpoints that are exempt from the CSRF check (mounted under the API base).
const CSRF_SKIP = new Set(['/auth/login']);

// Digest of a session token. Falls back to a plain SHA-256 only when no secret
// is configured (development), so behaviour is unchanged out of the box.
function sessionDigest(token) {
  if (!config.sessionSecret) return sha256(token);
  return crypto.createHmac('sha256', config.sessionSecret).update(String(token)).digest('hex');
}

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
  const tokenHash = sessionDigest(token);
  const session = db.find('sessions', (s) => s.tokenHash === tokenHash);
  const expiresAt = session ? Date.parse(session.expiresAt) : NaN;
  // An unparseable expiry is treated as expired rather than as valid.
  if (!session || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    if (session) db.remove('sessions', session.id);
    return res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'UNAUTHORIZED' });
  }
  const user = db.get('users', session.userId);
  if (!user) {
    db.remove('sessions', session.id);
    return res.status(401).json({ error: 'Your account no longer exists.', code: 'UNAUTHORIZED' });
  }
  // Deactivating an account takes effect immediately: the session is dropped
  // here, so no further request can use it. 401 (not 403) so the client drops
  // back to the sign-in screen instead of leaving a dead session in place.
  if (!isActiveUser(user)) {
    db.remove('sessions', session.id);
    return res.status(401).json({
      error: 'Your account has been deactivated. Please contact an administrator.',
      code: 'ACCOUNT_INACTIVE',
    });
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
  sessionDigest,
  parseCookies,
  setSessionCookies,
  clearSessionCookies,
  getSessionToken,
  authRequired,
  adminOnly,
  csrfProtect,
};
