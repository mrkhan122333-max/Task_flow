'use strict';

// Server-side authorization (RBAC) middleware.
//
// This is the authoritative access-control layer. The frontend hides buttons
// for a better experience, but every rule here is enforced again on the API so
// a crafted request cannot reach data the caller is not entitled to.
//
// Rules enforced:
//   * admin       → every project and every task.
//   * employee    → a task only when it is assigned to them, or it belongs to a
//                   project whose memberIds list contains them.
//   * unknown id  → 404, never 403, so the API does not confirm that a task the
//                   caller may not see actually exists.

const db = require('../db');
const { canAccessTask, canAccessProject, fail } = require('../lib/validate');

function taskIdFrom(req, param) {
  const fromParams = param ? req.params[param] : req.params.id;
  if (fromParams) return String(fromParams);
  const body = req.body || {};
  if (body.taskId) return String(body.taskId);
  if (body.id) return String(body.id);
  return '';
}

// Loads `req.task` when the caller may reach it, otherwise answers 404.
// `param` selects the route parameter holding the task id (default "id").
function requireTaskAccess(param) {
  return (req, res, next) => {
    const taskId = taskIdFrom(req, param);
    const task = taskId ? db.get('tasks', taskId) : null;
    if (!task || !canAccessTask(req.user, task)) {
      return fail(res, 404, 'Task not found.');
    }
    req.task = task;
    next();
  };
}

// Same lookup, but for routes that mutate a task. Kept as a separate
// middleware so the intent of each route is explicit and future rule changes
// (for example "employees may comment but not reassign") have an obvious home.
function requireTaskWrite(param) {
  return (req, res, next) => {
    const taskId = taskIdFrom(req, param);
    const task = taskId ? db.get('tasks', taskId) : null;
    if (!task || !canAccessTask(req.user, task)) {
      return fail(res, 404, 'Task not found.');
    }
    req.task = task;
    next();
  };
}

// Loads `req.project` when the caller may reach it, otherwise answers 404.
function requireProjectAccess(param) {
  return (req, res, next) => {
    const id = req.params[param || 'id'];
    const project = id ? db.get('projects', id) : null;
    if (!project || !canAccessProject(req.user, project)) {
      return fail(res, 404, 'Project not found.');
    }
    req.project = project;
    next();
  };
}

module.exports = {
  requireTaskAccess,
  requireTaskWrite,
  requireProjectAccess,
};
