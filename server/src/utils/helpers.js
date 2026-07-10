/**
 * Helper utilities.
 */
const crypto = require('crypto');

/** Generate a short unique ID. */
function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

/** Format duration from seconds to mm:ss. */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Sanitize filename (remove dangerous chars). */
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 200);
}

/** Estimate file size in MB from content-length bytes. */
function estimateSizeMB(bytes) {
  if (!bytes) return null;
  return Math.round((parseInt(bytes, 10) / 1024 / 1024) * 100) / 100;
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { generateId, formatDuration, sanitizeFilename, estimateSizeMB, sleep };