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
  version: 1,
  users: [],      // id, username, displayName, role, passwordHash, createdAt
  sessions: [],   // id, tokenHash, userId, createdAt, expiresAt
  projects: [],   // id, name, description, color, memberIds[], createdById, createdAt
  tasks: [],      // id, title, description, status, priority, assigneeId, projectId,
                  //     startDate, dueDate, subtasks[], createdById, createdAt, updatedAt
                  //     (priority: 'low' | 'medium' | 'high', default 'medium')
  comments: [],   // id, taskId, userId, text, fileId, createdAt
  files: [],      // id, originalName, storedName, size, ext, kind, mime,
                  //     uploadedById, taskId, commentId, createdAt
  messages: [],   // id, fromId, toId, text, read, createdAt
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Create the data + upload directories up-front so everything "just works".
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
    }
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