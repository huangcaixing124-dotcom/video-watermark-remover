/**
 * File cache with TTL and size limits.
 */
const fs = require('fs');
const path = require('path');

class FileCache {
  constructor(cacheDir, ttlSeconds, maxSizeMB) {
    this.cacheDir = cacheDir;
    this.ttlSeconds = ttlSeconds;
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  _keyPath(key) {
    const safe = Buffer.from(key).toString('base64url').slice(0, 100);
    return path.join(this.cacheDir, safe);
  }

  /** Check if cache has a valid entry for key. */
  has(key) {
    const p = this._keyPath(key);
    if (!fs.existsSync(p)) return false;
    const stat = fs.statSync(p);
    const age = (Date.now() - stat.mtimeMs) / 1000;
    return age < this.ttlSeconds;
  }

  /** Get cached file path (null if not found or expired). */
  get(key) {
    if (!this.has(key)) return null;
    return this._keyPath(key);
  }

  /** Put a file into cache. */
  put(key, filePath) {
    const dest = this._keyPath(key);
    try {
      fs.copyFileSync(filePath, dest);
    } catch {
      // If copy fails, try rename (for same-filesystem moves)
      try { fs.renameSync(filePath, dest); } catch {}
    }
    this._evictIfNeeded();
  }

  /** Delete a cached file. */
  delete(key) {
    const p = this._keyPath(key);
    try { fs.unlinkSync(p); } catch {}
  }

  /** Evict old entries when total size exceeds limit. */
  _evictIfNeeded() {
    try {
      const entries = fs.readdirSync(this.cacheDir).map(f => {
        const fp = path.join(this.cacheDir, f);
        try {
          const stat = fs.statSync(fp);
          return { path: fp, size: stat.size, mtime: stat.mtimeMs };
        } catch { return null; }
      }).filter(Boolean);

      const totalSize = entries.reduce((s, e) => s + e.size, 0);

      if (totalSize > this.maxSizeBytes) {
        // Sort oldest first and delete
        entries.sort((a, b) => a.mtime - b.mtime);
        let freed = 0;
        for (const entry of entries) {
          try {
            freed += entry.size;
            fs.unlinkSync(entry.path);
            if (freed > totalSize - this.maxSizeBytes * 0.8) break;
          } catch {}
        }
      }
    } catch {}
  }

  /** Clear all cached files. */
  clear() {
    try {
      const entries = fs.readdirSync(this.cacheDir);
      for (const f of entries) {
        try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch {}
      }
    } catch {}
  }
}

module.exports = FileCache;