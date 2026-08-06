/**
 * Shared bridge queue — manages URLs queued for the browser extension.
 *
 * Both video.js routes and transcriber.js service use this module
 * to submit URLs for bridge processing and wait for results.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { downloadFromUrl } = require('./ytdlp');

/** In-memory bridge task queue. */
const parseQueue = [];
let taskIdCounter = 0;

/** Add a URL to the bridge queue. Returns taskId. */
function addTask(url) {
  const taskId = `bridge_${++taskIdCounter}_${Date.now()}`;
  parseQueue.push({ taskId, url, status: 'pending', result: null, localFilePath: null, error: null, createdAt: Date.now(), _downloadPromise: null, completedAt: null });
  return taskId;
}

/** Get the next pending task (marks it as processing). */
function getNextPendingTask() {
  const pending = parseQueue.filter(t => t.status === 'pending');
  if (pending.length === 0) return null;
  pending.sort((a, b) => b.createdAt - a.createdAt);
  const task = pending[0];
  task.status = 'processing';
  return { taskId: task.taskId, url: task.url };
}

/** Report result from the bridge extension. */
function reportResult(taskId, videoUrl, error) {
  const task = parseQueue.find(t => t.taskId === taskId);
  if (!task) return null;
  task.result = videoUrl || null;
  task.error = error || null;
  task.completedAt = Date.now();

  if (videoUrl) {
    task.status = 'downloading';
    task._downloadPromise = downloadBridgeVideoToLocal(taskId, videoUrl);
    task._downloadPromise.then(() => {
      task.status = 'completed';
    }).catch(err => {
      task.status = 'completed';
    });
  } else {
    task.status = 'failed';
  }
  return task;
}

/** Get a task by ID. */
function getTask(taskId) {
  return parseQueue.find(t => t.taskId === taskId) || null;
}

/**
 * Wait for a bridge task to complete (polling).
 * Resolves with { videoUrl, localFilePath } as soon as the video URL is available
 * (doesn't wait for full local download to finish).
 * Rejects on timeout/failure.
 */
function waitForTask(taskId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const task = parseQueue.find(t => t.taskId === taskId);
      if (!task) return reject(new Error('任务不存在'));
      // Resolve as soon as we have the video URL (even if local download is still in progress)
      if (task.status === 'downloading' && task.result) {
        return resolve({ videoUrl: task.result, localFilePath: task.localFilePath });
      }
      if (task.status === 'completed') {
        return resolve({ videoUrl: task.result, localFilePath: task.localFilePath });
      }
      if (task.status === 'failed') {
        return reject(new Error(task.error || '桥接处理失败'));
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('桥接处理超时'));
      }
      setTimeout(poll, 1000);
    };
    poll();
  });
}

/** Clean up stale tasks (>5 min). */
function cleanup() {
  const now = Date.now();
  for (let i = parseQueue.length - 1; i >= 0; i--) {
    const t = parseQueue[i];
    if (now - t.createdAt > 300000) {
      if (t.localFilePath) {
        try {
          const dir = path.dirname(t.localFilePath);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
      parseQueue.splice(i, 1);
    }
  }
}

/** Get all tasks (for status checks). */
function getAllTasks() {
  return parseQueue;
}

/**
 * Download bridge-reported video URL to local server disk.
 */
async function downloadBridgeVideoToLocal(taskId, videoUrl) {
  const task = parseQueue.find(t => t.taskId === taskId);
  if (!task) return;

  const bridgeDir = path.join(config.cacheDir, 'bridge', taskId);
  fs.mkdirSync(bridgeDir, { recursive: true });
  const outputPath = path.join(bridgeDir, 'output.mp4');

  try {
    const result = await downloadFromUrl(videoUrl, outputPath, { sourceUrl: task.url, timeout: 120000 });
    let finalPath = result.filePath;

    // 如果是豆包视频，尝试去除水印
    if (task.url && task.url.includes('doubao.com')) {
      console.log(`[bridge] Running watermark removal for Doubao video...`);
      const cleanedPath = path.join(bridgeDir, 'cleaned.mp4');
      try {
        await runWatermarkRemoval(finalPath, cleanedPath);
        if (fs.existsSync(cleanedPath) && fs.statSync(cleanedPath).size > 1000) {
          finalPath = cleanedPath;
          console.log(`[bridge] Watermark removed: ${cleanedPath}`);
        }
      } catch (wmErr) {
        console.error(`[bridge] Watermark removal failed: ${wmErr.message}`);
      }
    }

    task.localFilePath = finalPath;
  } catch (err) {
    // Non-critical — task remains usable via proxy streaming
  }
}

module.exports = { addTask, getNextPendingTask, reportResult, getTask, waitForTask, getAllTasks, cleanup, runWatermarkRemoval };

/**
 * 使用 Python + OpenCV 去除豆包视频水印
 */
function runWatermarkRemoval(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.projectDir, 'server', 'scripts', 'remove_doubao_watermark.py');
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error('去水印脚本不存在'));
    }

    console.log(`[watermark] Removing watermark from ${path.basename(inputPath)}`);
    execFile('python', [scriptPath, inputPath, outputPath], {
      timeout: 300000,
      maxBuffer: 100 * 1024 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    }, (err, stdout, stderr) => {
      if (err) {
        const errStr = Buffer.isBuffer(stderr) ? stderr.toString('utf8').slice(0, 300) : String(stderr).slice(0, 300);
        console.error(`[watermark] Error: ${err.message}`);
        console.error(`[watermark] stderr: ${errStr}`);
        return reject(err);
      }
      const outStr = Buffer.isBuffer(stdout) ? stdout.toString('utf8').slice(0, 200) : String(stdout).slice(0, 200);
      console.log(`[watermark] Success: ${outStr}`);
      resolve();
    });
  });
}