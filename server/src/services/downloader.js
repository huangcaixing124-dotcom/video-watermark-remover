/**
 * Download task manager — handles async video download tasks.
 *
 * Each task goes through: pending → downloading → completed/failed
 * Tasks are persisted in memory with TTL-based cleanup.
 */
const path = require('path');
const fs = require('fs');
const { generateId, sleep, estimateSizeMB } = require('../utils/helpers');
const { downloadVideo, isRetryableError } = require('./ytdlp');
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

  const outputDir = path.join(DOWNLOAD_DIR, taskId);
  fs.mkdirSync(outputDir, { recursive: true });

  // 构建下载选项（进度回调只在 downloading 状态更新，重试期间对用户无感知）
  const buildOptions = () => {
    const downloadOptions = { progressCb: (pct) => {
      if (task && task.status === 'downloading') {
        task.progress = Math.max(task.progress, Math.min(99, pct));
      }
    } };
    if (task.directUrl) {
      downloadOptions.directUrl = task.directUrl;
    }
    return downloadOptions;
  };

  // 静默整体重试：最多尝试 3 次（首次 + 2 次重试）。
  // 只有可重试错误（SSL/连接重置/超时等网络波动）才重试；
  // 不可重试错误（视频不存在、格式不支持等）直接失败。
  // 重试期间用户可见状态保持 downloading，仅第 3 次彻底失败后置为 failed。
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  let success = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (task.directUrl && attempt === 1) {
      console.log(`[downloader] Using direct URL for task ${taskId}`);
    }
    if (attempt > 1) {
      // 重试前清空上次残留的输出文件，避免污染/误判
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(outputDir, { recursive: true });
      // 退避等待（1s, 2s），静默不打扰用户
      await sleep((attempt - 1) * 1000);
      console.log(`[downloader] 任务 ${taskId} 第 ${attempt}/${MAX_ATTEMPTS} 次尝试下载（上次: ${lastErr?.message}）`);
    }

    try {
      const result = await downloadVideo(task.url, outputDir, buildOptions());
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
      success = true;
      break;
    } catch (err) {
      lastErr = err;
      // 非可重试错误立即失败，不再重试
      if (!isRetryableError(err)) {
        console.log(`[downloader] 任务 ${taskId} 下载遇到不可重试错误，直接失败: ${err.message}`);
        break;
      }
      // 可重试错误：若还有次数则继续循环重试
      console.log(`[downloader] 任务 ${taskId} 下载失败(可重试): ${err.message}`);
    }
  }

  if (!success) {
    console.error(`[downloader] 任务 ${taskId} 尝试 ${MAX_ATTEMPTS} 次后仍失败: ${lastErr?.message}`);
    task.status = 'failed';
    task.error = (lastErr?.message || '下载失败').slice(0, 500);
  }

  activeDownloads--;
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

/**
 * 直接从磁盘查找任务文件（即使内存中的任务已被清理也能找到）。
 * 搜索 {cacheDir}/downloads/{taskId}/ 下的视频文件。
 */
function getTaskFileFromDisk(taskId) {
  const dir = path.join(DOWNLOAD_DIR, taskId);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f));
    if (files.length === 0) return null;
    // 选择最大文件
    files.sort((a, b) => {
      const sa = fs.statSync(path.join(dir, a)).size;
      const sb = fs.statSync(path.join(dir, b)).size;
      return sb - sa;
    });
    return path.join(dir, files[0]);
  } catch {
    return null;
  }
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

module.exports = { createTask, getTask, getTaskFile, getTaskFileFromDisk, startCleanup };