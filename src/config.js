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

function toAbsolute(envValue, fallback) {
  if (!envValue) return fallback;
  return path.isAbsolute(envValue) ? envValue : path.resolve(ROOT, envValue);
}

// Normalise the optional base path: '' = served at domain root (proxy strips
// the prefix), otherwise something like '/taskflow'.
let basePath = String(process.env.BASE_PATH || '').trim();
if (basePath && !basePath.startsWith('/')) basePath = '/' + basePath;
if (basePath.length > 1 && basePath.endsWith('/')) basePath = basePath.replace(/\/+$/, '');
if (basePath === '/') basePath = '';

const maxUploadMb = Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '25', 10) || 25);
const sessionTtlDays = Math.max(1, parseInt(process.env.SESSION_TTL_DAYS || '30', 10) || 30);

const config = {
  root: ROOT,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4321', 10),
  host: process.env.HOST || '0.0.0.0',
  basePath,
  apiBase: basePath + '/api',
  dataDir: toAbsolute(process.env.DATA_DIR, path.join(ROOT, 'data')),
  uploadDir: toAbsolute(process.env.UPLOAD_DIR, path.join(ROOT, 'uploads')),
  publicDir: path.join(ROOT, 'public'),
  dbFile: path.join(toAbsolute(process.env.DATA_DIR, path.join(ROOT, 'data')), 'data.json'),
  sessionTtlMs: sessionTtlDays * 24 * 60 * 60 * 1000,
  sessionTtlSeconds: sessionTtlDays * 24 * 60 * 60,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  maxUploadMb,
  cookiePath: basePath || '/',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};

module.exports = config;