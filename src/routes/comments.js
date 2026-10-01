'use strict';

// Comments on tasks (anyone with access to the task can read/write).

const express = require('express');
const db = require('../db');
const activity = require('../lib/activity');
const { cleanString, canAccessTask, fail } = require('../lib/validate');
const { authRequired } = require('../middleware/auth');
const { requireTaskAccess, requireTaskWrite } = require('../middleware/rbac');
const { deleteFileRecord } = require('./files');

const router = express.Router();

router.get('/tasks/:id/comments', authRequired, requireTaskAccess(), (req, res) => {
  const comments = db.filter('comments', (c) => c.taskId === req.task.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return res.json({ comments });
});

router.post('/comments', authRequired, requireTaskWrite(), (req, res) => {
  const task = req.task;

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
  activity.logComment(task, comment, req.user.id);
  return res.status(201).json({ comment });
});

router.delete('/comments/:id', authRequired, (req, res) => {
  const comment = db.get('comments', req.params.id);
  if (!comment) return fail(res, 404, 'Comment not found.');
  if (req.user.role !== 'admin' && comment.userId !== req.user.id) {
    return fail(res, 403, 'You can only delete your own comments.');
  }
  // An employee also needs access to the task the comment lives on.
  const task = db.get('tasks', comment.taskId);
  if (!task || !canAccessTask(req.user, task)) {
    return fail(res, 404, 'Comment not found.');
  }
  if (comment.fileId) deleteFileRecord(db.get('files', comment.fileId));
  db.remove('comments', comment.id);
  // The audit trail is append-only: a removal is recorded as new history
  // rather than by editing an existing entry.
  activity.append(task.id, req.user.id, activity.EVENT.COMMENT, {
    field: null,
    meta: { commentId: comment.id, removed: true },
  });
  return res.json({ ok: true });
});

module.exports = router;
