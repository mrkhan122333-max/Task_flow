'use strict';

// TaskFlow server — single Node process.
//
// Serves the SPA (public/) and the JSON API under /api (or /<base-path>/api).
// Deploy behind Nginx/Apache which reverse-proxies https://.../taskflow/ to
// this process. See README.md for the exact proxy configuration.

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./src/config');
const db = require('./src/db');
const { fail } = require('./src/lib/validate');
const { csrfProtect } = require('./src/middleware/auth');
const { MulterError } = require('./src/middleware/uploads');

const app = express();
app.disable('x-powered-by');
// We sit behind the web server, so honour a single X-Forwarded-For hop for
// correct client IPs (used by the login brute-force limiter).
app.set('trust proxy', 1);

// --- Security headers -----------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';" +
    " script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self';" +
    " object-src 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '2mb' }));

// --- API ------------------------------------------------------------------
const apiBase = config.apiBase; // '/api' or '/taskflow/api'
app.use(apiBase, csrfProtect);
app.use(apiBase, require('./src/routes/auth'));
app.use(apiBase, require('./src/routes/users'));
app.use(apiBase, require('./src/routes/projects'));
app.use(apiBase, require('./src/routes/tasks'));
app.use(apiBase, require('./src/routes/comments'));
app.use(apiBase, require('./src/routes/files'));
app.use(apiBase, require('./src/routes/messages'));
app.use(apiBase, require('./src/routes/search'));

app.get(apiBase + '/health', (req, res) => res.json({ ok: true, name: 'taskflow', time: new Date().toISOString() }));

app.use(apiBase, (req, res) => res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' }));

// --- Static SPA -----------------------------------------------------------
// Index is served through a template so the base path is injected into the
// page before the frontend loads.
const htmlTemplate = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8');

function serveIndex(req, res) {
  const html = htmlTemplate.split('__BASE__').join(config.basePath);
  res.type('html').send(html);
}

if (config.basePath) {
  app.get(config.basePath, (req, res) => res.redirect(config.basePath + '/'));
  app.get(config.basePath + '/', serveIndex);
} else {
  app.get('/', serveIndex);
}
app.use(config.basePath || '/', express.static(config.publicDir, { index: false, maxAge: '1h' }));

// --- Error handling -------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 400,
        `File too large. Maximum size is ${config.maxUploadMb} MB.`, 'FILE_TOO_LARGE');
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FIELD_COUNT') {
      return fail(res, 400, 'Unexpected upload field. Expected a single "file".', 'INVALID_UPLOAD');
    }
    return fail(res, 400, 'Upload failed: ' + err.message, 'UPLOAD_ERROR');
  }

  if (err && err.type === 'entity.too.large') {
    return fail(res, 413, 'Request body too large.', 'PAYLOAD_TOO_LARGE');
  }
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, 'Malformed JSON body.', 'BAD_JSON');
  }

  console.error('[server] Unhandled error:', err);
  return fail(res, 500, 'Internal server error.', 'INTERNAL');
});

app.listen(config.port, config.host, () => {
  console.log('────────────────────────────────────────────────');
  console.log('  TaskFlow');
  console.log(`  URL:      http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.basePath}/`);
  console.log(`  Data dir: ${config.dataDir}`);
  console.log(`  Uploads:  ${config.uploadDir}`);
  console.log(`  Users:    ${db.count('users')}`);
  console.log('────────────────────────────────────────────────');
});