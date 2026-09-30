// Central app state + tiny pub/sub. Cached lookups used by every view.

import { api } from './api.js';

export const store = {
  user: null,       // { id, username, displayName, role, createdAt }
  users: [],        // public user objects
  projects: [],     // { id, name, description, color, ... }
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
  const [u, p] = await Promise.all([
    api.get('/api/users'),
    api.get('/api/projects'),
  ]);
  store.users = u.users;
  store.projects = p.projects;
}

export function resetStore() {
  store.user = null;
  store.users = [];
  store.projects = [];
}

export function userById(id) {
  return store.users.find((u) => u.id === id) || null;
}

export function projectById(id) {
  return store.projects.find((p) => p.id === id) || null;
}