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
const { runWatermarkRemoval } = require('./bridgeQueue');
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
    const downloadOptions = { progressCb: (pct) => {
      if (task && task.status === 'downloading') {
        task.progress = Math.max(task.progress, Math.min(99, pct));
      }
    } };
    if (task.directUrl) {
      downloadOptions.directUrl = task.directUrl;
      console.log(`[downloader] Using direct URL for task ${taskId}`);
    }

    const result = await downloadVideo(task.url, outputDir, downloadOptions);

    task.filePath = result.filePath;

    // 尝试去除水印
    if (task.url) {
      let cleanedPath = null;
      try {
        if (task.url.includes('doubao.com')) {
          cleanedPath = path.join(outputDir, 'cleaned.mp4');
          await runWatermarkRemoval(result.filePath, cleanedPath);
        } else if (task.url.includes('kuaishou.com')) {
          // 快手视频 url 来自桥接扩展，已经是无水印的 CDN 链接，无需额外处理
          cleanedPath = null;
        }
        if (cleanedPath && fs.existsSync(cleanedPath) && fs.statSync(cleanedPath).size > 1000) {
          task.filePath = cleanedPath;
          console.log(`[downloader] Watermark removed for task ${taskId}`);
        }
      } catch (wmErr) {
        console.error(`[downloader] Watermark removal failed: ${wmErr.message}`);
      }
    }

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

/** Cleanup old completed/failed tasks. */
function cleanup() {
  const now = Date.now();
  const ttlMs = config.completedTaskTTLSeconds * 1000;

  for (const [id, task] of tasks) {
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