// Thin fetch wrapper for the Cosmic Info Solutions Task Management API.
// Handles JSON, CSRF headers, multipart uploads and a global "session expired"
// hook.

export const BASE = (window.__BASE__ !== undefined) ? window.__BASE__ : '';

const CSRF_COOKIE = 'cosmic_csrf';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getCsrf() {
  const parts = document.cookie.split('; ');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx) === CSRF_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1));
    }
  }
  return '';
}

// The app registers a handler here; it is invoked once per unauthorized answer
// so we can drop back to the login screen.
let unauthorizedHandler = null;
export function onUnauthorized(fn) { unauthorizedHandler = fn; }

async function request(path, options = {}) {
  const { method = 'GET', json, form } = options;
  const opts = { method, credentials: 'same-origin', headers: {} };

  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.body = form;
  }

  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (!safeMethods.includes(method.toUpperCase())) {
    const csrf = getCsrf();
    if (csrf) opts.headers['X-CSRF-Token'] = csrf;
  }

  let res;
  try {
    res = await fetch(BASE + path, opts);
  } catch (err) {
    throw new ApiError('Network error — is the server running?', 0, 'NETWORK');
  }

  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    data = {};
  }

  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.endsWith('/auth/me')) {
    if (unauthorizedHandler) unauthorizedHandler();
  }

  if (!res.ok) {
    throw new ApiError(data.error || ('Request failed (' + res.status + ')'), res.status, data.code);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, json) => request(path, { method: 'POST', json }),
  put: (path, json) => request(path, { method: 'PUT', json }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload: (path, formData) => request(path, { method: 'POST', form: formData }),
};

export function uploadFile(url, { taskId, commentId, file }) {
  const fd = new FormData();
  if (taskId) fd.append('taskId', taskId);
  if (commentId) fd.append('commentId', commentId);
  fd.append('file', file);
  return request(url, { method: 'POST', form: fd });
}