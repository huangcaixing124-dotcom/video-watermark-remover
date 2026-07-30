/**
 * Download task manager — handles async video download tasks.
 *
 * Each task goes through: pending → downloading → completed/failed
 * Tasks are persisted in memory with TTL-based cleanup.
 */
const path = require('path');
const fs = require('fs');
const { generateId, sleep, estimateSizeMB } = require('../utils/helpers');
const { downloadVideo } = require('./ytdlp');
const config = require('../config');

/** In-memory task store. */
const tasks = new Map();

/** Max concurrent downloads. */
let activeDownloads = 0;

/** Download directory. */
const DOWNLOAD_DIR = path.join(config.cacheDir, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/** Create a download task with optional pre-populated info. */
function createTask(url, info = null) {
  const taskId = generateId();
  const task = {
    id: taskId,
    url,
    status: 'pending',
    progress: 0,
    title: info?.title || null,
    platform: info?.platform || null,
    directUrl: info?.directUrl || null,
    filePath: null,
    error: null,
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);
  startDownload(taskId);
  return task;
}

/** Start downloading a task (with concurrency control). */
async function startDownload(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;

  // Wait if at max concurrency
  while (activeDownloads >= config.maxConcurrentDownloads) {
    task.status = 'pending';
    await sleep(5000);
  }

  activeDownloads++;
  task.status = 'downloading';

  try {
    const outputDir = path.join(DOWNLOAD_DIR, taskId);
    fs.mkdirSync(outputDir, { recursive: true });

    // Build options for downloadVideo
    const downloadOptions = {};
    if (task.directUrl) {
      downloadOptions.directUrl = task.directUrl;
      console.log(`[downloader] Using direct URL for task ${taskId}`);
    }

    const result = await downloadVideo(task.url, outputDir, downloadOptions);

    task.filePath = result.filePath;
    task.status = 'completed';
    task.progress = 100;
  } catch (err) {
    const existing = tasks.get(taskId);
    if (existing) {
      existing.status = 'failed';
      existing.error = err.message.slice(0, 500);
    }
  } finally {
    activeDownloads--;
    // Queue next pending task
    for (const t of tasks.values()) {
      if (t.status === 'pending' && typeof t._url === 'string') {
        // Will be restarted by caller if needed
        break;
      }
    }
  }
}

/** Get task status. */
function getTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    title: task.title,
    platform: task.platform,
    filePath: task.filePath,
    error: task.error,
    createdAt: task.createdAt,
  };
}

/** Get the video file path for a task. */
function getTaskFile(taskId) {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'completed') return null;
  return task.filePath;
}

/** Cleanup old completed/failed tasks AND timeout hung downloads. */
function cleanup() {
  const now = Date.now();
  const ttlMs = config.completedTaskTTLSeconds * 1000;
  const downloadTimeoutMs = (config.downloadTimeout || 300) * 1000; // default 5 min

  for (const [id, task] of tasks) {
    // Timeout hung downloads
    if (task.status === 'downloading' && now - task.createdAt > downloadTimeoutMs) {
      console.warn(`[downloader] Task ${id} timed out after ${downloadTimeoutMs/1000}s`);
      task.status = 'failed';
      task.error = '下载超时，请重试。如果问题持续，可能需要浏览器辅助下载。';
    }

    // Cleanup old completed/failed tasks
    if (task.status === 'completed' || task.status === 'failed') {
      if (now - task.createdAt > ttlMs) {
        // Delete files
        if (task.filePath) {
          const dir = path.dirname(task.filePath);
          try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
              fs.unlinkSync(path.join(dir, f));
            }
            fs.rmdirSync(dir);
          } catch {}
        }
        tasks.delete(id);
      }
    }
  }
}

/** Start periodic cleanup. */
function startCleanup() {
  setInterval(cleanup, config.taskCleanupIntervalSeconds * 1000);
}

module.exports = { createTask, getTask, getTaskFile, startCleanup };