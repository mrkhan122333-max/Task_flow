'use strict';

// Cosmic Info Solutions — Task Management server. Single Node process.
//
// Serves the SPA (public/) and the JSON API under /api (or /<base-path>/api).
// Deploy behind Nginx, which terminates TLS for
// https://tasks.cosmicinfosolutions.com and reverse-proxies to this process.
// See README.md and deploy/nginx/ for the exact configuration.
//
// Production rules enforced here:
//   * NODE_ENV=production — no development behaviour, no auto-reload, generic
//     error responses with no stack traces leaked to the client.
//   * X-Forwarded-* headers are trusted for exactly TRUST_PROXY_HOPS hops, so
//     req.ip and req.secure are correct behind the reverse proxy.
//   * HSTS is sent on every HTTPS response.
//   * All state-changing calls require a valid CSRF token.

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
// We sit behind Nginx, so honour the configured number of X-Forwarded-For hops
// for correct client IPs (used by the login brute-force limiter) and read
// X-Forwarded-Proto to decide whether the request arrived over HTTPS.
app.set('trust proxy', config.trustProxy);
if (config.isProduction) {
  app.set('env', 'production');
  // There is no debug mode. Express must never fall back to a dev error page.
  app.set('view cache', true);
}

// --- Security headers -----------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Strict-Transport-Security is only meaningful (and only safe to send) once
  // the request really did arrive over HTTPS via the proxy.
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isHttps = req.secure || forwardedProto === 'https';
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';" +
    " script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self';" +
    " object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  next();
});

app.use(express.json({ limit: '2mb' }));

// --- API ------------------------------------------------------------------
const apiBase = config.apiBase; // '/api' or '/cosmic-tasks/api'
app.use(apiBase, csrfProtect);
app.use(apiBase, require('./src/routes/auth'));
app.use(apiBase, require('./src/routes/users'));
app.use(apiBase, require('./src/routes/projects'));
app.use(apiBase, require('./src/routes/tasks'));
app.use(apiBase, require('./src/routes/comments'));
app.use(apiBase, require('./src/routes/files'));
app.use(apiBase, require('./src/routes/messages'));
app.use(apiBase, require('./src/routes/activity'));
app.use(apiBase, require('./src/routes/stats'));
app.use(apiBase, require('./src/routes/search'));

app.get(apiBase + '/health', (req, res) => res.json({
  ok: true,
  name: 'cosmic-tasks',
  app: config.appName,
  env: config.nodeEnv,
  time: new Date().toISOString(),
}));

app.use(apiBase, (req, res) => res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' }));

// --- Static SPA -----------------------------------------------------------
// Index is served through a template so the base path is injected into the
// page before the frontend loads.
const htmlTemplate = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8');

function serveIndex(req, res) {
  const html = htmlTemplate.split('__BASE__').join(config.basePath);
  res.type('html').set('Cache-Control', 'no-cache').send(html);
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

  // Never send a stack trace to the browser. The full error is written to the
  // process log (journald / docker logs) where operators can read it.
  console.error('[server] Unhandled error:', err);
  if (config.isProduction) {
    return fail(res, 500, 'Internal server error.', 'INTERNAL');
  }
  return fail(res, 500, 'Internal server error: ' + err.message, 'INTERNAL');
});

const server = app.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('────────────────────────────────────────────────');
  console.log('  ' + config.appName);
  console.log('  URL:       http://' + shownHost + ':' + config.port + config.basePath + '/');
  console.log('  Public:    ' + config.publicUrl);
  console.log('  Mode:      ' + config.nodeEnv + (config.isProduction ? '' : '  (development)'));
  console.log('  Data dir:  ' + config.dataDir);
  console.log('  Uploads:   ' + config.uploadDir);
  console.log('  Users:     ' + db.count('users'));
  console.log('  Trust proxy hops: ' + config.trustProxy + ' (X-Forwarded-Proto honoured)');
  console.log('────────────────────────────────────────────────');
});

if (config.isProduction) {
  // A hung keep-alive connection should not hold the process open on shutdown.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  // Surface early write failures (e.g. a full persistent volume) instead of
  // letting the request appear to succeed.
  server.on('error', (err) => console.error('[server] HTTP server error:', err.message));
}

// --- Graceful shutdown ----------------------------------------------------
// systemd / Docker send SIGTERM before SIGKILL, so this is the chance to stop
// accepting connections and let in-flight requests finish.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] ' + signal + ' received — shutting down gracefully.');
  server.close(() => {
    console.log('[server] All connections closed. Exiting.');
    process.exit(0);
  });
  // Hard stop if a connection refuses to drain.
  setTimeout(() => {
    console.error('[server] Graceful shutdown timed out — forcing exit.');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

module.exports = app;
