/**
 * Server configuration from environment variables.
 */
const path = require('path');
const fs = require('fs');

// Load .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const SERVER_DIR = __dirname;

module.exports = {
  // Server
  port: parseInt(process.env.PORT || '8800', 10),
  host: process.env.HOST || '0.0.0.0',

  // Directories
  serverDir: SERVER_DIR,
  projectDir: path.resolve(SERVER_DIR, '..', '..'),
  cacheDir: path.resolve(SERVER_DIR, process.env.CACHE_DIR || '.cache'),

  // Download
  downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT_SECONDS || '300', 10),
  maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10),
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10),

  // Cache
  cacheTTLSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '86400', 10),
  cacheMaxSizeMB: parseInt(process.env.CACHE_MAX_SIZE_MB || '5000', 10),

  // Task cleanup
  completedTaskTTLSeconds: parseInt(process.env.COMPLETED_TASK_TTL_SECONDS || '3600', 10),
  taskCleanupIntervalSeconds: parseInt(process.env.TASK_CLEANUP_INTERVAL_SECONDS || '300', 10),

  // Whisper
  whisperModelSize: process.env.WHISPER_MODEL_SIZE || 'small',
  whisperDevice: process.env.WHISPER_DEVICE || 'cpu',
  whisperComputeType: process.env.WHISPER_COMPUTE_TYPE || 'int8',

  // Douyin proxy APIs - used to resolve Douyin URLs without cookies
  // Each entry is a template with {url} placeholder
  douyinProxyAPIs: (process.env.DOUYIN_PROXY_APIS || '').split(',').filter(Boolean),
};