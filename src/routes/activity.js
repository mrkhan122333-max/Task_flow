'use strict';

// Task audit trail (read-only).
//
// The activity list is append-only on the server: there is no endpoint that
// edits or deletes an entry, so the history shown in the task detail drawer is
// exactly what the API recorded. Access is filtered by the same RBAC rule as
// the task itself — an employee who cannot open the task cannot read its
// history either.

const express = require('express');
const db = require('../db');
const activity = require('../lib/activity');
const { scopedTaskList, todayISO, isOverdue, publicActor } = require('../lib/validate');
const { authRequired } = require('../middleware/auth');
const { requireTaskAccess } = require('../middleware/rbac');

const router = express.Router();

function nameOf(userId) {
  const user = db.get('users', userId);
  return user ? (user.displayName || user.username) : 'Removed user';
}

router.get('/tasks/:id/activity', authRequired, requireTaskAccess(), (req, res) => {
  return res.json({
    activity: activity.timelineForTask(req.task.id),
    // Handy for the header: who created it, who owns it, and when it landed.
    summary: {
      createdById: req.task.createdById || null,
      creatorName: req.task.createdById ? nameOf(req.task.createdById) : null,
      assigneeId: req.task.assigneeId || null,
      assigneeName: req.task.assigneeId ? nameOf(req.task.assigneeId) : null,
      completedAt: req.task.completedAt || null,
      createdAt: req.task.createdAt || null,
      updatedAt: req.task.updatedAt || null,
    },
  });
});

// A compact, task-scoped variant used by the dashboard "recent activity" list.
router.get('/activity/recent', authRequired, (req, res) => {
  const visibleTaskIds = new Set(scopedTaskList(req.user).map((t) => t.id));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const today = todayISO();

  const entries = db.all('activity')
    .filter((entry) => visibleTaskIds.has(entry.taskId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);

  const usersById = new Map(db.all('users').map((u) => [u.id, u]));
  const tasksById = new Map(db.all('tasks').map((t) => [t.id, t]));

  return res.json({
    activity: entries.map((entry) => {
      const task = tasksById.get(entry.taskId);
      const actor = usersById.get(entry.actorId);
      const projection = publicActor(actor);
      return {
        id: entry.id,
        taskId: entry.taskId,
        type: entry.type,
        field: entry.field,
        from: entry.from,
        to: entry.to,
        meta: entry.meta,
        createdAt: entry.createdAt,
        taskTitle: task ? task.title : 'Deleted task',
        taskStatus: task ? task.status : null,
        taskOverdue: task ? isOverdue(task, today) : false,
        // Same shape as the task timeline so one renderer serves both lists.
        actor: projection,
        actorName: projection.name,
      };
    }),
  });
});

module.exports = router;
