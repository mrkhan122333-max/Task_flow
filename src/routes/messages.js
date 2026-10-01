'use strict';

// 1:1 direct messaging (polling-based, no external service).

const express = require('express');
const db = require('../db');
const { cleanString, isActiveUser, publicUser, fail } = require('../lib/validate');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Conversation list: every other active user, plus the last message + unread
// count. Deactivated accounts disappear from the list, although their existing
// message history is preserved.
router.get('/inbox', authRequired, (req, res) => {
  const me = req.user.id;
  const allMessages = db.all('messages');
  const conversations = [];

  for (const user of db.all('users')) {
    if (user.id === me) continue;
    if (!isActiveUser(user)) continue;
    const msgs = allMessages.filter((m) =>
      (m.fromId === me && m.toId === user.id) || (m.fromId === user.id && m.toId === me));
    msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const unread = msgs.filter((m) => m.fromId === user.id && m.toId === me && !m.read).length;
    conversations.push({ user: publicUser(user), last, unread });
  }

  conversations.sort((a, b) => {
    if (a.last && b.last) return a.last.createdAt < b.last.createdAt ? 1 : -1;
    if (a.last) return -1;
    if (b.last) return 1;
    return String(a.user.displayName || '').localeCompare(String(b.user.displayName || ''));
  });

  return res.json({ conversations });
});

// Full thread with one user.
router.get('/conversations/:userId', authRequired, (req, res) => {
  const other = db.get('users', req.params.userId);
  if (!other) return fail(res, 404, 'User not found.');
  const me = req.user.id;
  const messages = db.filter('messages', (m) =>
    (m.fromId === me && m.toId === other.id) || (m.fromId === other.id && m.toId === me))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-300);
  return res.json({ other: publicUser(other), messages });
});

// Send a message to any other active user (Admin ↔ Employee, Employee ↔ Employee).
router.post('/messages', authRequired, (req, res) => {
  const toId = req.body && req.body.toId ? String(req.body.toId) : '';
  const recipient = db.get('users', toId);
  if (!recipient) return fail(res, 404, 'Recipient does not exist.');
  if (!isActiveUser(recipient)) return fail(res, 400, 'That account has been deactivated.');
  if (toId === req.user.id) return fail(res, 400, 'You cannot message yourself.');

  const text = cleanString(req.body && req.body.text, 2000, { allowNewlines: true });
  if (!text) return fail(res, 400, 'Message text is required.');

  const message = db.insert('messages', {
    fromId: req.user.id,
    toId,
    text,
    read: false,
  });
  return res.status(201).json({ message });
});

// Mark everything from that user as read (called when the thread is opened).
router.post('/conversations/:userId/read', authRequired, (req, res) => {
  const other = db.get('users', req.params.userId);
  if (!other) return fail(res, 404, 'User not found.');
  const me = req.user.id;
  const pending = db.filter('messages', (m) => m.fromId === other.id && m.toId === me && !m.read);
  let updated = 0;
  if (pending.length) {
    const pendingIds = new Set(pending.map((m) => m.id));
    db.replace('messages', db.all('messages').map((m) => (
      pendingIds.has(m.id) ? Object.assign({}, m, { read: true }) : m
    )));
    updated = pending.length;
  }
  return res.json({ ok: true, updated });
});

module.exports = router;