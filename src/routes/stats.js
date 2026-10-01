'use strict';

// Dashboard metrics.
//
// The numbers are computed on the server so the admin and employee dashboards
// always agree with the task list and the automatic Overdue rule, even when a
// page has been left open across midnight.
//
//   Admin dashboard    → Total Tasks, In Progress, Completed, Overdue, Due Today
//   Employee dashboard → My Tasks, Due Today, Overdue, Completed
//
// An employee only ever sees their own assigned tasks; admins additionally get
// the company-wide figures.

const express = require('express');
const db = require('../db');
const {
  todayISO, isOverdue, isDueToday, assignedTaskList, scopedTaskList, fail,
} = require('../lib/validate');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function summarise(tasks, today) {
  return {
    total: tasks.length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    onHold: tasks.filter((t) => t.status === 'on_hold').length,
    notStarted: tasks.filter((t) => t.status === 'not_started').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    overdue: tasks.filter((t) => isOverdue(t, today)).length,
    dueToday: tasks.filter((t) => isDueToday(t, today)).length,
  };
}

router.get('/stats', authRequired, (req, res) => {
  const today = todayISO();

  // "My Tasks" is always the caller's own assignments.
  const mine = summarise(assignedTaskList(req.user), today);
  // Everything the caller may see: all tasks for an admin, the RBAC-scoped set
  // for an employee.
  const visible = summarise(scopedTaskList(req.user), today);

  return res.json({
    role: req.user.role,
    today,
    admin: visible,
    mine,
    // The headline numbers for whichever dashboard this user actually sees.
    metrics: req.user.role === 'admin' ? visible : mine,
  });
});

// Per-assignee workload, used by the admin dashboard breakdown.
router.get('/stats/workload', authRequired, (req, res) => {
  if (req.user.role !== 'admin') {
    return fail(res, 403, 'Admin access required.', 'FORBIDDEN');
  }
  const today = todayISO();
  const tasks = db.all('tasks');
  const rows = new Map();

  for (const task of tasks) {
    const key = task.assigneeId || 'unassigned';
    if (!rows.has(key)) {
      rows.set(key, {
        userId: task.assigneeId || null,
        total: 0,
        inProgress: 0,
        completed: 0,
        overdue: 0,
        dueToday: 0,
      });
    }
    const row = rows.get(key);
    row.total += 1;
    if (task.status === 'in_progress') row.inProgress += 1;
    if (task.status === 'completed') row.completed += 1;
    if (isOverdue(task, today)) row.overdue += 1;
    if (isDueToday(task, today)) row.dueToday += 1;
  }

  const workload = Array.from(rows.values()).sort((a, b) => b.total - a.total);
  return res.json({ workload, today });
});

// Headcount split by role, shown on the admin dashboard.
router.get('/stats/headcount', authRequired, (req, res) => {
  if (req.user.role !== 'admin') {
    return fail(res, 403, 'Admin access required.', 'FORBIDDEN');
  }
  const users = db.all('users');
  return res.json({
    total: users.length,
    admins: users.filter((u) => u.role === 'admin').length,
    employees: users.filter((u) => u.role === 'employee').length,
    activeEmployees: users.filter((u) => u.role === 'employee' && u.active !== false).length,
    deactivated: users.filter((u) => u.active === false).length,
  });
});

module.exports = router;
