'use strict';

// Lightweight JSON-file database.
//
// The entire dataset lives in one in-memory object and is persisted to a single
// JSON file. Writes are synchronous and atomic (temp file + rename), which is
// safe because the app runs as one single Node process. No external DB server
// is required — see the deploy constraints.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const EMPTY_DATA = {
  version: 2,
  users: [],      // id, username, displayName, email, department, designation,
                  //     role ('admin' | 'employee'), active, passwordHash,
                  //     lastLoginAt, createdAt
  sessions: [],   // id, tokenHash, userId, createdAt, expiresAt
  projects: [],   // id, name, description, color, memberIds[], createdById, createdAt
  tasks: [],      // id, title, description, status, priority, assigneeId, projectId,
                  //     startDate, dueDate, completedAt, subtasks[], createdById,
                  //     createdAt, updatedAt
                  //     (priority: 'low' | 'medium' | 'high' | 'critical', default 'medium')
  comments: [],   // id, taskId, userId, text, fileId, createdAt
  files: [],      // id, originalName, storedName, size, ext, kind, mime,
                  //     uploadedById, taskId, commentId, createdAt
  messages: [],   // id, fromId, toId, text, read, createdAt
  activity: [],   // APPEND-ONLY audit trail. id, taskId, actorId, type, field,
                  //     from, to, meta{}, createdAt
                  //     (never updated or deleted while the task exists)
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Create the data + upload directories up-front so everything "just works".
// In production they live on a persistent volume — see README.md.
function ensureDirectories() {
  ensureDir(config.dataDir);
  ensureDir(config.uploadDir);
}

class Database {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(JSON.stringify(EMPTY_DATA));
    this.load();
  }

  load() {
    ensureDir(path.dirname(this.file));
    if (!fs.existsSync(this.file)) {
      this.persist();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = Object.assign(JSON.parse(JSON.stringify(EMPTY_DATA)), parsed);
    } catch (err) {
      // Never crash on a corrupted file — back it up and start fresh.
      console.error('[db] Failed to read data file, starting fresh:', err.message);
      try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (e) { /* best effort */ }
      this.data = JSON.parse(JSON.stringify(EMPTY_DATA));
      this.persist();
      return;
    }
    if (this.migrate()) this.persist();
  }

  // ---------------------------------------------------------------------------
  // Schema migrations. Each one upgrades an older data file in place and is
  // idempotent, so restarting the app never re-runs a completed step.
  // ---------------------------------------------------------------------------
  migrate() {
    const d = this.data;
    let changed = false;
    const notes = [];
    let renamedRoles = 0;

    // v1 → v2: "analyst" was renamed to "employee", and every account gained
    // the e-mail / department / designation / active profile fields.
    for (const user of d.users) {
      if (user.role === 'analyst') {
        user.role = 'employee';
        renamedRoles += 1;
        changed = true;
      }
      if (user.active === undefined) {
        user.active = true;
        changed = true;
      }
      if (user.email === undefined) { user.email = ''; changed = true; }
      if (user.department === undefined) { user.department = ''; changed = true; }
      if (user.designation === undefined) { user.designation = ''; changed = true; }
      if (user.lastLoginAt === undefined) { user.lastLoginAt = null; changed = true; }
    }
    if (renamedRoles) {
      notes.push(renamedRoles + ' account(s) renamed from Analyst to Employee');
    }

    // v1 → v2: tasks gained a completion timestamp.
    for (const task of d.tasks) {
      if (task.completedAt === undefined) {
        // Legacy rows: the best available approximation is the last update, and
        // only when the task is actually completed.
        task.completedAt = (task.status === 'completed' ? (task.updatedAt || null) : null);
        changed = true;
      }
    }

    // v1 → v2: the append-only activity trail. Existing tasks get a single
    // "created" entry so their history is never silently empty.
    if (!Array.isArray(d.activity)) {
      d.activity = [];
      changed = true;
    }
    const loggedTaskIds = new Set(d.activity.map((a) => a.taskId));
    const backfilled = [];
    for (const task of d.tasks) {
      if (loggedTaskIds.has(task.id)) continue;
      backfilled.push({
        id: crypto.randomUUID(),
        taskId: task.id,
        actorId: task.createdById || null,
        type: 'created',
        field: null,
        from: null,
        to: null,
        meta: {
          title: task.title,
          status: task.status,
          priority: task.priority || 'medium',
          assigneeId: task.assigneeId || null,
          projectId: task.projectId || null,
          dueDate: task.dueDate || null,
        },
        createdAt: task.createdAt || this.now(),
      });
    }
    if (backfilled.length) {
      d.activity = backfilled.concat(d.activity);
      changed = true;
    }

    if (d.version !== EMPTY_DATA.version) {
      d.version = EMPTY_DATA.version;
      changed = true;
    }

    if (changed) {
      for (const note of notes) console.log('[db] migration: ' + note);
      if (backfilled.length) {
        console.log('[db] migration: backfilled ' + backfilled.length + ' activity entr' +
          (backfilled.length === 1 ? 'y' : 'ies'));
      }
    }
    return changed;
  }

  // Atomic write: write to a .tmp file then rename over the real file.
  persist() {
    ensureDir(path.dirname(this.file));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  now() {
    return new Date().toISOString();
  }

  all(table) {
    const list = this.data[table];
    if (!list) throw new Error('Unknown table: ' + table);
    return list;
  }

  find(table, predicate) {
    return this.all(table).find(predicate) || null;
  }

  filter(table, predicate) {
    return this.all(table).filter(predicate);
  }

  get(table, id) {
    if (id === null || id === undefined) return null;
    return this.all(table).find((row) => row.id === id) || null;
  }

  insert(table, row) {
    if (!row.id) row.id = crypto.randomUUID();
    if (!row.createdAt) row.createdAt = this.now();
    this.all(table).push(row);
    this.persist();
    return row;
  }

  update(table, id, patch) {
    const row = this.get(table, id);
    if (!row) return null;
    Object.assign(row, patch);
    row.id = id; // id is immutable
    this.persist();
    return row;
  }

  remove(table, id) {
    const list = this.all(table);
    const index = list.findIndex((row) => row.id === id);
    if (index === -1) return false;
    list.splice(index, 1);
    this.persist();
    return true;
  }

  // Replace a whole table (used for bulk cascades) and persist once.
  replace(table, rows) {
    if (!Array.isArray(rows)) throw new Error('replace expects an array');
    this.data[table] = rows;
    this.persist();
  }

  count(table, predicate) {
    return predicate ? this.filter(table, predicate).length : this.all(table).length;
  }
}

ensureDirectories();

module.exports = new Database(config.dbFile);
module.exports.ensureDirectories = ensureDirectories;
module.exports.EMPTY_DATA = EMPTY_DATA;
