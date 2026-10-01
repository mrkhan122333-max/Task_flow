// Central app state + tiny pub/sub. Cached lookups used by every view.

import { api } from './api.js';

export const store = {
  // { id, username, displayName, email, department, designation, role, active }
  user: null,
  // Public projections of every account, including deactivated ones so the UI
  // can still show "(inactive)" instead of silently losing a name.
  users: [],
  projects: [],     // { id, name, description, color, memberIds, ... }
  departments: [],
};

const listeners = {};
export function on(event, fn) {
  (listeners[event] = listeners[event] || []).push(fn);
}

export function off(event, fn) {
  listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
}

export function emit(event, data) {
  (listeners[event] || []).forEach((fn) => {
    try { fn(data); } catch (err) { console.error('[store] listener error', err); }
  });
}

export async function loadCaches() {
  const [u, p, d] = await Promise.all([
    api.get('/api/users'),
    api.get('/api/projects'),
    api.get('/api/users/departments').catch(() => ({ departments: [] })),
  ]);
  store.users = u.users;
  store.projects = p.projects;
  store.departments = d.departments || [];
}

export function resetStore() {
  store.user = null;
  store.users = [];
  store.projects = [];
  store.departments = [];
}

export function userById(id) {
  return store.users.find((u) => u.id === id) || null;
}

export function projectById(id) {
  return store.projects.find((p) => p.id === id) || null;
}

// Only active employees can be assigned new work.
export function assignableUsers() {
  return store.users.filter((u) => u.role === 'employee' && u.active !== false);
}