'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader (no third-party dependency). Existing environment
// variables always win so process managers/CI can override the file.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  }
}

const ROOT = path.join(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

// The .env file must never be readable by anybody but the app user.
try {
  fs.chmodSync(path.join(ROOT, '.env'), 0o600);
} catch (err) { /* not supported on every platform — best effort */ }

function toAbsolute(envValue, fallback) {
  if (!envValue) return fallback;
  return path.isAbsolute(envValue) ? envValue : path.resolve(ROOT, envValue);
}

function intEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

// Normalise the optional base path: '' = served at domain root (proxy strips
// the prefix), otherwise something like '/cosmic-tasks'.
let basePath = String(process.env.BASE_PATH || '').trim();
if (basePath && !basePath.startsWith('/')) basePath = '/' + basePath;
if (basePath.length > 1 && basePath.endsWith('/')) basePath = basePath.replace(/\/+$/, '');
if (basePath === '/') basePath = '';

const maxUploadMb = Math.max(1, intEnv('MAX_UPLOAD_MB', 25));
const sessionTtlDays = Math.max(1, intEnv('SESSION_TTL_DAYS', 30));

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

// ---------------------------------------------------------------------------
// Secrets — every sensitive value is read from the environment only. Nothing
// secret is ever hard-coded in this repository.
// ---------------------------------------------------------------------------
const sessionSecret = String(process.env.SESSION_SECRET || '').trim();
if (isProduction && !sessionSecret) {
  console.error(
    '\n[FATAL] SESSION_SECRET is not set.\n' +
    '        Production refuses to start without a secret. Generate one with:\n' +
    '          node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
    '        then add SESSION_SECRET=<value> to your .env file.\n'
  );
  process.exit(1);
}
// The .env.example template ships a literal placeholder. Treating it as a real
// secret would mean every installation shares the same key, so fail loudly
// instead of quietly signing sessions with a public value.
if (sessionSecret && /^CHANGE_?ME/i.test(sessionSecret)) {
  console.error(
    '\n[FATAL] SESSION_SECRET is still the .env.example placeholder.\n' +
    '        Generate a real one with:\n' +
    '          node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n'
  );
  process.exit(1);
}
if (isProduction && sessionSecret.length < 32) {
  console.error('\n[FATAL] SESSION_SECRET must be at least 32 characters.\n');
  process.exit(1);
}
if (!isProduction && !sessionSecret) {
  console.warn('[config] SESSION_SECRET is not set — sessions will be signed with an ephemeral key and will not survive a restart.');
}

// Number of reverse proxies in front of the app. 1 = a single Nginx hop, which
// is what the shipped Nginx config uses. Required for correct req.ip and for
// honouring X-Forwarded-Proto (HTTPS detection).
const trustProxy = intEnv('TRUST_PROXY_HOPS', 1);

// The sender name/address may be supplied as a single RFC 5322 string
// (SMTP_FROM) or as the friendlier SMTP_FROM_NAME + SMTP_FROM_EMAIL pair used
// by the .env.example template. The pair wins only when SMTP_FROM is unset.
function resolveFromAddress() {
  const explicit = String(process.env.SMTP_FROM || '').trim();
  if (explicit) return explicit;
  const addr = String(process.env.SMTP_FROM_EMAIL || '').trim();
  const name = String(process.env.SMTP_FROM_NAME || '').trim();
  if (!addr) return 'Cosmic Info Solutions <no-reply@cosmicinfosolutions.com>';
  if (!name) return addr;
  // Quote the display name unless it is already an atom-safe phrase.
  const display = /^[A-Za-z0-9 ._-]+$/.test(name) ? name : '"' + name.replace(/"/g, '\\"') + '"';
  return display + ' <' + addr + '>';
}

const smtp = {
  host: String(process.env.SMTP_HOST || '').trim(),
  port: intEnv('SMTP_PORT', 587),
  // true = implicit TLS (usually port 465), false = plain connection.
  secure: boolEnv('SMTP_SECURE', false),
  user: String(process.env.SMTP_USER || '').trim(),
  pass: String(process.env.SMTP_PASS || ''),
  from: resolveFromAddress(),
  // Defaults to "on" as soon as a host is configured. Forcing SMTP_ENABLED
  // explicitly is still supported for tests and for deliberately parked
  // credentials; without the fallback, filling in SMTP_HOST alone would leave
  // password-reset mails silently disabled.
  enabled: boolEnv('SMTP_ENABLED', !!String(process.env.SMTP_HOST || '').trim()),
};

const config = {
  root: ROOT,
  appName: 'Cosmic Info Solutions Task Management',
  appShort: 'Cosmic Tasks',
  nodeEnv,
  isProduction,
  port: intEnv('PORT', 4321),
  host: process.env.HOST || '0.0.0.0',
  basePath,
  apiBase: basePath + '/api',
  // Public canonical origin, used for absolute links in notification emails.
  publicUrl: String(process.env.PUBLIC_URL || 'https://tasks.cosmicinfosolutions.com').replace(/\/+$/, ''),
  dataDir: toAbsolute(process.env.DATA_DIR, path.join(ROOT, 'data')),
  uploadDir: toAbsolute(process.env.UPLOAD_DIR, path.join(ROOT, 'uploads')),
  publicDir: path.join(ROOT, 'public'),
  dbFile: path.join(toAbsolute(process.env.DATA_DIR, path.join(ROOT, 'data')), 'data.json'),
  sessionTtlMs: sessionTtlDays * 24 * 60 * 60 * 1000,
  sessionTtlSeconds: sessionTtlDays * 24 * 60 * 60,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  maxUploadMb,
  cookiePath: basePath || '/',
  // Secure cookies are mandatory in production (the site is HTTPS-only).
  cookieSecure: isProduction ? true : boolEnv('COOKIE_SECURE', false),
  sessionSecret,
  trustProxy,
  smtp,
};

module.exports = config;
