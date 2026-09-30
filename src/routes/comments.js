'use strict';

// Comments on tasks (assignee or admin can read/write).

const express = require('express');
const db = require('../db');
const { cleanString, canAccessTask, fail } = require('../lib/validate');
const { authRequired } = require('../middleware/auth');
const { deleteFileRecord } = require('./files');

const router = express.Router();

router.get('/tasks/:id/comments', authRequired, (req, res) => {
  const task = db.get('tasks', req.params.id);
  if (!task || !canAccessTask(req.user, task)) return fail(res, 404, 'Task not found.');
  const comments = db.filter('comments', (c) => c.taskId === task.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return res.json({ comments });
});

router.post('/comments', authRequired, (req, res) => {
  const taskId = req.body && req.body.taskId ? String(req.body.taskId) : '';
  const task = db.get('tasks', taskId);
  if (!task || !canAccessTask(req.user, task)) return fail(res, 404, 'Task not found.');

  const text = cleanString(req.body && req.body.text, 5000, { allowNewlines: true });
  if (!text) return fail(res, 400, 'Comment text is required.');

  let fileId = null;
  if (req.body && req.body.fileId) {
    const file = db.get('files', String(req.body.fileId));
    if (!file || file.taskId !== task.id) {
      return fail(res, 400, 'The attached file does not belong to this task.');
    }
    fileId = file.id;
  }

  const comment = db.insert('comments', {
    taskId: task.id,
    userId: req.user.id,
    text,
    fileId,
  });
  // Mark the file as a comment attachment so it no longer appears in the
  // task's standalone attachment list.
  if (fileId) db.update('files', fileId, { commentId: comment.id });
  return res.status(201).json({ comment });
});

router.delete('/comments/:id', authRequired, (req, res) => {
  const comment = db.get('comments', req.params.id);
  if (!comment) return fail(res, 404, 'Comment not found.');
  if (req.user.role !== 'admin' && comment.userId !== req.user.id) {
    return fail(res, 403, 'You can only delete your own comments.');
  }
  if (comment.fileId) deleteFileRecord(db.get('files', comment.fileId));
  db.remove('comments', comment.id);
  return res.json({ ok: true });
});

module.exports = router;