'use strict';

// File upload / download / listing / deletion.
// Also exposes shared helpers used by tasks.js and comments.js so files are
// cleaned up in one place.

const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const activity = require('../lib/activity');
const { cleanString, canAccessTask, fail } = require('../lib/validate');
const { authRequired } = require('../middleware/auth');
const { requireTaskAccess } = require('../middleware/rbac');
const { singleFile, allowedExtension, sanitizeOriginalName, magicMatches, kindFor } = require('../middleware/uploads');

const router = express.Router();

function fileDiskPath(file) {
  return path.join(config.uploadDir, file.storedName);
}

function deleteFileRecord(file) {
  if (!file) return;
  try { fs.unlinkSync(fileDiskPath(file)); } catch (err) { /* already gone */ }
  db.remove('files', file.id);
}

function publicFile(file) {
  return {
    id: file.id,
    originalName: file.originalName,
    size: file.size,
    ext: file.ext,
    kind: file.kind,
    createdAt: file.createdAt,
    uploadedById: file.uploadedById,
    url: config.apiBase + '/files/' + file.id + '/content',
  };
}

function fileAccessAllowed(user, file) {
  if (!user || !file) return false;
  if (user.role === 'admin') return true;
  if (file.uploadedById === user.id) return true;
  if (file.taskId) {
    const task = db.get('tasks', file.taskId);
    if (task && canAccessTask(user, task)) return true;
  }
  if (file.commentId) {
    const comment = db.get('comments', file.commentId);
    if (comment) {
      const task = db.get('tasks', comment.taskId);
      if (task && canAccessTask(user, task)) return true;
    }
  }
  return false;
}

// Permitted targets for an upload: either an existing task (assignee or admin)
// or a comment that belongs to such a task.
function resolveUploadTarget(user, body) {
  let taskId = null;
  let commentId = null;
  if (body && body.taskId && cleanString(body.taskId, 64)) {
    taskId = String(body.taskId);
    const task = db.get('tasks', taskId);
    if (!task) return { error: { status: 400, message: 'Task does not exist.' } };
    if (!canAccessTask(user, task)) {
      return { error: { status: 403, message: 'You do not have access to this task.' } };
    }
  }
  if (body && body.commentId && cleanString(body.commentId, 64)) {
    commentId = String(body.commentId);
    const comment = db.get('comments', commentId);
    if (!comment) return { error: { status: 400, message: 'Comment does not exist.' } };
    if (comment.taskId !== taskId) {
      return { error: { status: 400, message: 'Comment does not belong to the given task.' } };
    }
    const task = db.get('tasks', comment.taskId);
    if (!task || !canAccessTask(user, task)) {
      return { error: { status: 403, message: 'You do not have access to this comment.' } };
    }
  }
  return { taskId, commentId };
}

router.post('/upload', authRequired, singleFile, (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return fail(res, 400, 'No file was provided.');
    }

    const ext = allowedExtension(req.file.originalname);
    if (!ext) {
      return fail(res, 400, 'This file type is not allowed. Supported: ' + ['pdf','doc','docx','txt','xls','xlsx','csv','ppt','pptx','png','jpg','jpeg','gif','webp','zip','rar','7z'].join(', ') + '.');
    }
    if (!magicMatches(ext, req.file.buffer)) {
      return fail(res, 400, 'File content does not match its extension.');
    }

    const target = resolveUploadTarget(req.user, req.body);
    if (target.error) {
      return res.status(target.error.status).json({ error: target.error.message, code: 'FORBIDDEN' });
    }

    const storedName = crypto.randomUUID() + '.' + ext;
    fs.writeFileSync(fileDiskPath({ storedName }), req.file.buffer);

    const file = db.insert('files', {
      originalName: sanitizeOriginalName(req.file.originalname),
      storedName,
      size: req.file.size,
      ext,
      kind: kindFor(ext),
      mime: req.file.mimetype || 'application/octet-stream',
      uploadedById: req.user.id,
      taskId: target.taskId,
      commentId: target.commentId,
    });
    if (target.taskId) {
      const task = db.get('tasks', target.taskId);
      if (task) activity.logFile(task, file, req.user.id);
    }
    return res.status(201).json({ file: publicFile(file) });
  } catch (err) {
    return next(err);
  }
});

// List files attached to a task (caller must be able to reach the task).
router.get('/tasks/:id/files', authRequired, requireTaskAccess(), (req, res) => {
  const files = db.filter('files', (f) => f.taskId === req.task.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(publicFile);
  return res.json({ files });
});

// Stream a stored file back to the browser.
router.get('/files/:id/content', authRequired, (req, res) => {
  const file = db.get('files', req.params.id);
  if (!file || !fileAccessAllowed(req.user, file)) {
    return fail(res, 404, 'File not found.');
  }
  const abs = fileDiskPath(file);
  if (!fs.existsSync(abs)) {
    return fail(res, 404, 'File is missing on the server.');
  }
  const inline = file.kind === 'image' || file.kind === 'pdf' || ['txt', 'md', 'csv'].includes(file.ext);
  const asciiName = file.originalName.replace(/[^\x20-\x7E]/g, '?');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
  return res.sendFile(abs);
});

router.delete('/files/:id', authRequired, (req, res) => {
  const file = db.get('files', req.params.id);
  if (!file) return fail(res, 404, 'File not found.');
  if (req.user.role !== 'admin' && file.uploadedById !== req.user.id) {
    return fail(res, 403, 'You can only delete files you uploaded.');
  }
  // Re-check task access so an employee cannot remove an attachment from a
  // task they lost access to (e.g. removed from the project).
  const task = file.taskId ? db.get('tasks', file.taskId) : null;
  if (task && !canAccessTask(req.user, task)) {
    return fail(res, 404, 'File not found.');
  }
  const taskId = file.taskId;
  deleteFileRecord(file);
  if (taskId) {
    const parent = db.get('tasks', taskId);
    if (parent) {
      activity.append(parent.id, req.user.id, activity.EVENT.FILE, {
        field: null,
        meta: { name: file.originalName, removed: true },
      });
    }
  }
  return res.json({ ok: true });
});

module.exports = router;
module.exports.fileDiskPath = fileDiskPath;
module.exports.deleteFileRecord = deleteFileRecord;
module.exports.publicFile = publicFile;