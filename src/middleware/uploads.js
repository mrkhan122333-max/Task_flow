'use strict';

// File upload handling: multer disk-less (memory) upload for auth + validation,
// strict allow-list of extensions, filename sanitisation (prevents path
// traversal) and a light magic-byte check so a renamed payload can't slip past
// as a "pdf" or "zip".

const path = require('path');
const multer = require('multer');
const config = require('../config');

const ALLOWED_EXTENSIONS = new Set([
  // documents
  'pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'md', 'ppt', 'pptx', 'odp', 'csv', 'tsv',
  // spreadsheets
  'xls', 'xlsx', 'ods', 'numbers', 'pages', 'key',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic',
  // archives
  'zip', 'rar', '7z', 'tar', 'gz',
  // misc
  'json', 'log',
]);

// Zip-based Office formats share the OLE/zip magic bytes.
const ZIP_LIKE = new Set(['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);

function getExt(name) {
  return path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
}

function allowedExtension(name) {
  const ext = getExt(name);
  return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

// Replace any path component / forbidden characters so the returned name can
// never escape the uploads directory.
function sanitizeOriginalName(name) {
  let base = String(name || 'file');
  base = base.replace(/\\/g, '/').split('/').pop();        // strip any directory part
  base = base.replace(/[\u0000-\u001F\u007F<>:"|?*]/g, ''); // control + path chars
  base = base.replace(/\.+$/, '').trim();                   // trailing dots
  if (!base) base = 'file';
  const ext = path.extname(base);
  if (base.length > 120) base = base.slice(0, 120 - ext.length) + ext;
  return base;
}

// Verify the first bytes of a buffer match the declared extension.
function magicMatches(ext, buffer) {
  const b = buffer.subarray(0, 16);
  const startsWith = (hex) => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  switch (ext) {
    case 'pdf':    return b.subarray(0, 5).toString('binary') === '%PDF-';
    case 'png':    return startsWith('89504e470d0a1a0a');
    case 'jpg':
    case 'jpeg':   return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'gif':    return b.toString('binary').startsWith('GIF8');
    case 'webp':   return b.subarray(0, 4).toString('binary') === 'RIFF' && b.subarray(8, 12).toString('binary') === 'WEBP';
    case 'heic':   return b.subarray(4, 12).toString('binary').includes('ftyp');
    default: {
      if (ZIP_LIKE.has(ext)) return startsWith('504b0304') || startsWith('504b0506') || startsWith('504b0708');
      return true; // remaining types: no strict signature check
    }
  }
}

function kindFor(ext) {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'ppt', 'pptx', 'odp', 'pages', 'key'].includes(ext)) return 'document';
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers'].includes(ext)) return 'sheet';
  if (['json', 'log'].includes(ext)) return 'text';
  return 'other';
}

// Multer instance: a single "file" field, held in memory until validated.
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 },
});

module.exports = {
  singleFile: uploader.single('file'),
  MulterError: multer.MulterError,
  allowedExtension,
  sanitizeOriginalName,
  magicMatches,
  kindFor,
  ALLOWED_EXTENSIONS,
};