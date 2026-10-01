'use strict';

// Dependency-free SMTP notifier.
//
// Used to tell an employee when an administrator resets their password. All
// credentials come from the environment (SMTP_HOST / SMTP_USER / SMTP_PASS …),
// never from source. If SMTP is not configured the sender is a no-op: the
// caller still receives the temporary password so it can be handed over
// out-of-band, and a warning is logged once.
//
// Message bodies are base64-encoded, which removes every dot-stuffing and
// 8-bit / quoted-printable edge case.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const config = require('../config');

const HELO_DOMAIN = process.env.SMTP_HELO || 'cosmicinfosolutions.com';
const TIMEOUT_MS = 15000;
const MAX_LOGGED_WARNINGS = 5;
let warnings = 0;

function warnOnce(message) {
  if (warnings >= MAX_LOGGED_WARNINGS) return;
  warnings += 1;
  console.warn('[mailer] ' + message);
}

function isConfigured() {
  return !!(config.smtp.enabled && config.smtp.host);
}

// Pull the bare address out of `Display Name <someone@example.com>`.
function extractAddress(value) {
  const m = /<([^>]+)>/.exec(String(value || ''));
  return (m ? m[1] : String(value || '')).trim();
}

function encodeHeaderWord(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}

function base64Body(text) {
  const b64 = Buffer.from(String(text).replace(/\r\n/g, '\n'), 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) || ['']).join('\r\n');
}

function dotStuff(text) {
  return String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function buildMessage({ from, to, subject, text }) {
  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encodeHeaderWord(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomUUID() + '@' + HELO_DOMAIN + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
  ];
  return dotStuff(headers.join('\r\n'));
}

// ---------------------------------------------------------------------------
// Minimal SMTP conversation
// ---------------------------------------------------------------------------
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.pendingText = '';
    this.waiter = null;
    this.lastResponse = null;
    this.capabilities = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', () => { /* surfaced through the command timeout */ });
  }

  handleData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.pendingText = this.pendingText ? this.pendingText + '\n' + line.slice(4) : line.slice(4);
      if (line[3] === '-') continue; // multi-line continuation
      const response = { code: parseInt(line.slice(0, 3), 10), text: this.pendingText };
      this.pendingText = '';
      // Only the EHLO reply is consulted for capabilities, and it is always
      // read immediately before `supports()` is called.
      this.capabilities = response.text;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(response);
      } else {
        this.lastResponse = response;
      }
      return;
    }
  }

  // A reply can arrive before anybody is waiting for it (the SMTP greeting is
  // typically already in the socket buffer by the time we attach). Such a
  // reply is parked in `lastResponse` and consumed here first.
  readWithTimeout(ms) {
    if (this.lastResponse) {
      const parked = this.lastResponse;
      this.lastResponse = null;
      return Promise.resolve(parked);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve({ code: 0, text: 'timeout' });
      }, ms);
      this.waiter = (response) => { clearTimeout(timer); resolve(response); };
    });
  }

  async command(line) {
    this.socket.write(line + '\r\n');
    return this.expect();
  }

  // Read the reply to a multi-line write (the DATA payload) without sending
  // anything further.
  async expect() {
    const response = await this.readWithTimeout(TIMEOUT_MS);
    if (response.code === 0) throw new Error('SMTP timeout waiting for a reply');
    if (response.code >= 400) throw new Error('SMTP ' + response.code + ': ' + response.text.trim());
    return response;
  }

  supports(capability) {
    return this.capabilities.toUpperCase().indexOf(capability.toUpperCase()) !== -1;
  }

  detach() {
    this.socket.removeAllListeners('data');
    this.waiter = null;
  }

  destroy() {
    try { this.socket.destroy(); } catch (err) { /* already gone */ }
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const options = { host: config.smtp.host, port: config.smtp.port };
    const socket = config.smtp.secure
      ? tls.connect(Object.assign({ servername: config.smtp.host, rejectUnauthorized: true }, options))
      : net.connect(options);
    socket.setTimeout(TIMEOUT_MS);
    socket.once(config.smtp.secure ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function startTls(rawSocket) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect(
      { socket: rawSocket, servername: config.smtp.host, rejectUnauthorized: true },
      () => resolve(secureSocket)
    );
    secureSocket.setTimeout(TIMEOUT_MS);
    secureSocket.once('error', reject);
  });
}

async function handshake() {
  const socket = await connect();
  let session = new SmtpSession(socket);
  let encrypted = !!config.smtp.secure;

  try {
    let response = await session.readWithTimeout(TIMEOUT_MS);
    if (response.code !== 220) {
      throw new Error('Unexpected SMTP greeting: ' + response.code);
    }

    response = await session.command('EHLO ' + HELO_DOMAIN);
    if (!encrypted && response.code === 250 && session.supports('STARTTLS')) {
      session.detach();
      const secureSocket = await startTls(socket);
      session = new SmtpSession(secureSocket);
      response = await session.command('EHLO ' + HELO_DOMAIN);
      encrypted = true;
    }

    if (config.smtp.user) {
      // Credentials must never travel in clear text. A stripped or missing
      // STARTTLS advertisement is a classic downgrade attack, so fail closed.
      if (!encrypted) {
        throw new Error('Refusing to send SMTP credentials over an unencrypted connection ' +
          '(enable TLS, or connect to a host that advertises STARTTLS)');
      }
      if (!config.smtp.pass) {
        throw new Error('SMTP_USER is set but SMTP_PASS is empty');
      }
      await session.command('AUTH LOGIN');
      await session.command(Buffer.from(config.smtp.user, 'utf8').toString('base64'));
      await session.command(Buffer.from(config.smtp.pass, 'utf8').toString('base64'));
    }

    return session;
  } catch (err) {
    // The caller only receives a session on success, so a failure here has to
    // release the socket itself or every failed mail attempt leaks a
    // connection.
    session.destroy();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Sends a plain-text message. Never throws: transport problems are logged and
// reported through the resolved boolean so they can never break an API call.
async function sendMail({ to, subject, text }) {
  const recipient = extractAddress(to);
  if (!isConfigured()) return false;
  if (!recipient) {
    warnOnce('Refusing to send: no recipient address.');
    return false;
  }

  let session = null;
  try {
    session = await handshake();
    await session.command('MAIL FROM:<' + extractAddress(config.smtp.from) + '>');
    await session.command('RCPT TO:<' + recipient + '>');
    await session.command('DATA');
    session.socket.write(buildMessage({
      from: config.smtp.from,
      to: recipient,
      subject: subject,
      text: text,
    }) + '\r\n.\r\n');
    await session.expect(); // the terminating "." yields the final reply
    try { await session.command('QUIT'); } catch (err) { /* server may close first */ }
    return true;
  } catch (err) {
    warnOnce('Could not send "' + subject + '" to ' + recipient + ': ' + err.message);
    return false;
  } finally {
    if (session) session.destroy();
  }
}

// Password-reset notice: the plaintext password is only ever included in this
// message, which is why SMTP must be configured over TLS in production.
async function sendPasswordResetNotice({ to, name, username, password, resetBy }) {
  const appName = config.appName;
  const text = [
    'Hello ' + (name || username) + ',',
    '',
    'An administrator (' + (resetBy || 'Cosmic Info Solutions') + ') has reset the password',
    'for your ' + appName + ' account.',
    '',
    '  Sign-in username : ' + username,
    '  Temporary password: ' + password,
    '  Sign in at        : ' + config.publicUrl + '/',
    '',
    'For your security: sign in and change this password immediately, then',
    'delete this email. If you did not expect this reset, contact your',
    'administrator right away.',
    '',
    '— ' + appName,
  ].join('\n');

  return sendMail({
    to: to || '',
    subject: 'Your ' + appName + ' password was reset',
    text: text,
  });
}

module.exports = {
  isConfigured,
  sendMail,
  sendPasswordResetNotice,
  HELO_DOMAIN,
};
