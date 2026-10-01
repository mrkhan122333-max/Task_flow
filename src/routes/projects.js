'use strict';

// Projects (admin creates; everyone reads).

const express = require('express');
const db = require('../db');
const activity = require('../lib/activity');
const { cleanString, validHexColor, canAccessProject, fail } = require('../lib/validate');
const { authRequired, adminOnly } = require('../middleware/auth');
const { requireProjectAccess } = require('../middleware/rbac');

const router = express.Router();

const DEFAULT_COLOR = '#4f46e5';

// memberIds: an optional list of user IDs who may see the project (employees).
// Every entry must be a real user and duplicates are dropped. Admins are always
// able to see every project, so they never need to be listed here.
function parseMemberIds(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'memberIds must be an array of user IDs.' };
  const value = [];
  for (const id of raw) {
    const sid = String(id);
    const user = db.get('users', sid);
    if (!user) return { error: 'memberIds contains a user that does not exist.' };
    // Admins already have full access, so listing one adds nothing.
    if (user.role === 'admin') continue;
    if (!value.includes(sid)) value.push(sid);
  }
  return { value };
}

router.get('/projects', authRequired, (req, res) => {
  const projects = db.all('projects')
    .filter((p) => canAccessProject(req.user, p))
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return res.json({ projects });
});

router.get('/projects/:id', authRequired, requireProjectAccess(), (req, res) => {
  return res.json({ project: req.project });
});

router.post('/projects', authRequired, adminOnly, (req, res) => {
  const body = req.body || {};
  const name = cleanString(body.name, 100);
  const description = cleanString(body.description, 1000, { allowNewlines: true });
  if (!name) return fail(res, 400, 'Project name is required.');

  const color = body.color && validHexColor(body.color) ? body.color : DEFAULT_COLOR;
  const memberIds = parseMemberIds(body.memberIds);
  if (memberIds.error) return fail(res, 400, memberIds.error);
  const project = db.insert('projects', {
    name,
    description,
    color,
    memberIds: memberIds.value,
    createdById: req.user.id,
  });
  return res.status(201).json({ project });
});

router.put('/projects/:id', authRequired, adminOnly, (req, res) => {
  const project = db.get('projects', req.params.id);
  if (!project) return fail(res, 404, 'Project not found.');
  const body = req.body || {};
  const patch = {};

  if (body.hasOwnProperty('name')) {
    const name = cleanString(body.name, 100);
    if (!name) return fail(res, 400, 'Project name is required.');
    patch.name = name;
  }
  if (body.hasOwnProperty('description')) {
    patch.description = cleanString(body.description, 1000, { allowNewlines: true });
  }
  if (body.hasOwnProperty('memberIds')) {
    const memberIds = parseMemberIds(body.memberIds);
    if (memberIds.error) return fail(res, 400, memberIds.error);
    patch.memberIds = memberIds.value;
  }
  if (body.hasOwnProperty('color')) {
    if (!validHexColor(body.color)) return fail(res, 400, 'Invalid color.');
    patch.color = body.color;
  }
  if (Object.keys(patch).length === 0) {
    return fail(res, 400, 'No changes provided.');
  }
  patch.updatedAt = db.now();
  const updated = db.update('projects', project.id, patch);
  return res.json({ project: updated });
});

router.delete('/projects/:id', authRequired, adminOnly, (req, res) => {
  const project = db.get('projects', req.params.id);
  if (!project) return fail(res, 404, 'Project not found.');

  // Detach tasks that referenced the project, and record the move so the audit
  // trail explains why a task lost its project chip.
  const detached = db.filter('tasks', (t) => t.projectId === project.id);
  for (const task of detached) {
    activity.append(task.id, req.user.id, activity.EVENT.PROJECT, {
      field: 'projectId',
      from: project.id,
      to: null,
      meta: { projectName: project.name, removed: true },
    });
  }
  if (detached.length) {
    db.replace('tasks', db.all('tasks').map((t) => (
      t.projectId === project.id ? { ...t, projectId: null, updatedAt: db.now() } : t
    )));
  }
  db.remove('projects', project.id);
  return res.json({ ok: true, detachedTasks: detached.length });
});

module.exports = router;