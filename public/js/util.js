// Shared helpers: escaping, formatting, status metadata, small DOM utils.
// Everything rendered from user data MUST pass through esc() to prevent XSS.

export const STATUS = ['not_started', 'in_progress', 'on_hold', 'completed'];

export const STATUS_META = {
  not_started: { label: 'Not Started', color: '#8b93a5', bg: '#eef0f4', short: 'NS' },
  in_progress: { label: 'In Progress', color: '#2563eb', bg: '#e7efff', short: 'IP' },
  on_hold:     { label: 'On Hold',     color: '#d97706', bg: '#fff4e0', short: 'OH' },
  completed:   { label: 'Completed',   color: '#059669', bg: '#e4f7f0', short: 'CO' },
};

// Priority labels/colors (object key order = display order: High → Low).
export const PRIORITY_META = {
  high:   { label: 'High',   color: '#dc2626', bg: '#fee2e2' },
  medium: { label: 'Medium', color: '#d97706', bg: '#fef3c7' },
  low:    { label: 'Low',    color: '#64748b', bg: '#e2e8f0' },
};

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  // A bare 'YYYY-MM-DD' is a calendar date, not an instant: build it from its
  // own year/month/day so rendering never shifts a day in a timezone behind
  // UTC. Anything else (dates with a time) parses normally.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(s);
  if (Number.isNaN(d.getTime())) return esc(s);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return fmtDateTime(iso);
}

export function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

export function isOverdue(task) {
  return !!(task.dueDate && task.dueDate < todayISO() && task.status !== 'completed');
}

export function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
  };
}

export function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#2563eb,#4f46e5)',
  'linear-gradient(135deg,#7c3aed,#a855f7)',
  'linear-gradient(135deg,#0ea5e9,#2563eb)',
  'linear-gradient(135deg,#10b981,#059669)',
  'linear-gradient(135deg,#f59e0b,#d97706)',
  'linear-gradient(135deg,#ec4899,#db2777)',
  'linear-gradient(135deg,#64748b,#475569)',
  'linear-gradient(135deg,#0891b2,#0e7490)',
];

function hashId(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function avatarGradient(id) {
  return AVATAR_GRADIENTS[hashId(id) % AVATAR_GRADIENTS.length];
}

export function initials(name) {
  const clean = String(name || '?').trim();
  const words = clean.split(/\s+/).filter(Boolean).slice(0, 2);
  if (!words.length) return '?';
  return words.map((w) => w[0].toUpperCase()).join('');
}

export function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

const FILE_ICON_COLORS = {
  pdf: '#dc2626', doc: '#2563eb', docx: '#2563eb', xls: '#059669', xlsx: '#059669',
  csv: '#059669', ppt: '#ea580c', pptx: '#ea580c', zip: '#7c3aed', rar: '#7c3aed',
  txt: '#64748b', md: '#64748b', json: '#64748b', log: '#64748b',
  png: '#0891b2', jpg: '#0891b2', jpeg: '#0891b2', gif: '#0891b2', webp: '#0891b2', svg: '#0891b2',
};

export function fileAccent(ext) {
  return FILE_ICON_COLORS[ext] || '#64748b';
}

export function fileLabel(ext) {
  const map = {
    xlsx: 'Excel', xls: 'Excel', docx: 'Word', doc: 'Word', pdf: 'PDF', png: 'Image',
    jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image', svg: 'Image', zip: 'Archive',
    csv: 'Sheet', txt: 'Text', rar: 'Archive', pptx: 'Slides', ppt: 'Slides',
  };
  return (ext || '').toUpperCase() !== '' ? (map[String(ext).toLowerCase()] || String(ext).toUpperCase()) : 'File';
}

// Browser-safe copy helper.
export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

export function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}