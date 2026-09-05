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

/**
 * 取消某用户所有仍在"处理中/排队/下载中"的旧片段任务，并删除已下载的旧目录。
 * - downloading：kill 正在跑的 ffmpeg，真正释放带宽。
 * - processing/pending：扩展已取走但尚未回报 URL、或仍在排队——置为 cancelled，
 *   让扩展下次拉新任务时不再响应它们（配合扩展端"新任务顶替旧任务"清理旧标签页）。
 * 仅处理目标 userId 的任务，绝不触碰其他用户，避免误伤多人并发使用。
 */
function cancelUserInFlight(userId) {
  if (!userId || userId === 'anonymous') return; // 无可靠标识不明文做顶替，宁可少取消不误杀
  for (const t of parseQueue) {
    if (t.userId !== userId) continue; // 只动同用户
    if (t.status === 'downloading' || t.status === 'processing' || t.status === 'pending') {
      console.log(`[bridge] 用户 ${t.userId} 提交了新任务，取消其旧任务 ${t.taskId} (${t.status})`);
      if (t.status === 'downloading' && typeof t._kill === 'function') {
        try { t._kill(); } catch {}
      }
      t.status = 'cancelled';
      t.error = '已被该用户的新任务取代';
      // 删除旧任务已下载的目录，避免陈旧文件残留占用空间
      if (t.localFilePath) {
        try {
          const dir = path.dirname(t.localFilePath);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}

/** Add a URL to the bridge queue. Returns taskId. taskType: 'video' | 'image' */
function addTask(url, userId, taskType) {
  const taskId = `bridge_${++taskIdCounter}_${Date.now()}`;
  userId = userId || 'anonymous';
  taskType = taskType || 'video';
  // 同用户提交新解析 → 立即取消其旧的仍在下载的任务（核心诉求：旧的马上停、立刻执行新任务）
  cancelUserInFlight(userId);
  parseQueue.push({ taskId, url, userId, taskType, status: 'pending', result: null, images: [], localFilePath: null, error: null, createdAt: Date.now(), _downloadPromise: null, _kill: null, completedAt: null });
  return taskId;
}

/** 单个桥接任务"被扩展拉走但迟迟未回报"的容忍窗口（毫秒）。 */
const PROCESSING_STALE_MS = 60000;

/**
 * Get the next pending task (marks it as processing).
 * 若某任务被取走后超过 PROCESSING_STALE_MS 仍未回报（扩展侧超时/中断/页面未出 URL），
 * 重置回 pending，让后续轮询能重试，避免永久卡在"等待浏览器处理"。
 */
function getNextPendingTask() {
  const now = Date.now();
  // 先把"取走了但很久没回报"的 processing 任务重置为 pending，供重试
  for (const t of parseQueue) {
    if (t.status === 'processing' && now - t.createdAt > PROCESSING_STALE_MS) {
      console.log(`[bridge] Task ${t.taskId} 拉取后 ${PROCESSING_STALE_MS / 1000}s 未回报，重置为 pending 以便重试`);
      t.status = 'pending';
      t.error = null;
      t.lastProcessingAt = now;
    }
  }

  const pending = parseQueue.filter(t => t.status === 'pending');
  if (pending.length === 0) return null;
  pending.sort((a, b) => b.createdAt - a.createdAt);
  const task = pending[0];
  task.status = 'processing';
  return { taskId: task.taskId, url: task.url, taskType: task.taskType || 'video' };
}

/** Report result from the bridge extension. */
function reportResult(taskId, videoUrl, error, images) {
  const task = parseQueue.find(t => t.taskId === taskId);
  if (!task) return null;
  // 该任务已被"同用户新提交"取消(kill)过，其迟到的 URL/图片不再触发新的下载，避免复活死任务。
  if (task.status === 'cancelled') return task;

  // 幂等去重：同一 taskId 已被回报过一次(已进入 downloading/completed)，后续重复上报一律忽略。
  // 这是"重复下载同一 output"的最终服务端兜底（扩展端去重是单点，这里补可靠防线）。
  if (task.status === 'downloading' || task.status === 'completed') {
    console.log(`[bridge] Task ${taskId} 已处理过，忽略重复上报`);
    return task;
  }

  // 图文任务：扩展回报的是图片 URL 列表而非视频。直接存 images、置 completed，不触发 ffmpeg 下载。
  // 必须先于下方"videoUrl 为空则置 failed"的 else 判断，避免图文被误判失败。
  if (images && Array.isArray(images) && images.length) {
    task.images = images;
    task.result = null;
    task.error = null;
    task.status = 'completed';
    task.completedAt = Date.now();
    console.log(`[bridge] Task ${taskId} 图文解析完成，图片 ${images.length} 张`);
    return task;
  }

  task.result = videoUrl || null;
  task.error = error || null;
  task.completedAt = Date.now();

  if (videoUrl) {
    task.status = 'downloading';
    task._downloadPromise = downloadBridgeVideoToLocal(taskId, videoUrl);
    task._downloadPromise.then(() => {
      // 仅当未被"新任务顶替"取消时才置 completed，避免被 kill 后又被标记完成、file/:id 误serve。
      if (task.status !== 'cancelled') task.status = 'completed';
    }).catch(() => {
      if (task.status !== 'cancelled') task.status = 'completed';
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

  console.log(`[bridge] downloadBridgeVideoToLocal start task=${taskId} -> ${outputPath}`);
  console.log(`[bridge]   videoUrl(前160): ${String(videoUrl).slice(0, 160)}`);
  // 暴露取消句柄：新任务顶替时可通过 task._kill() 中止本任务的 ffmpeg。
  task._kill = () => {};
  try {
    let result;
    try {
      result = await downloadFromUrl(videoUrl, outputPath, {
        sourceUrl: task.url,
        timeout: 120000,
        // ffmpeg spawn 后把进程句柄交给 task._kill，供"新任务顶替"时 kill 掉，真正释放带宽
        onSpawn: (proc) => {
          task._kill = () => { try { proc.kill('SIGTERM'); } catch {} };
        },
      });
    } catch (dlErr) {
      // 暴露最终落盘失败的根因，不再静默吞掉（原 catch{} 吞掉导致目录恒空、无法定位）
      console.error(`[bridge] downloadFromUrl FAILED task=${taskId}: ${dlErr && dlErr.message}`);
      try {
        const info = `${DL_HTTP_PROBE(videoUrl)}`;
        console.error(`[bridge]   http probe: ${info}`);
      } catch {}
      task._kill = null;
      return;
    }
    let finalPath = result.filePath;
    console.log(`[bridge] downloadFromUrl OK task=${taskId} filePath=${finalPath}`);

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
    task._kill = null;
  } catch (err) {
    console.error(`[bridge] downloadBridgeVideoToLocal unexpected error task=${taskId}: ${(err && err.message) || err}`);
    task._kill = null;
  }
}

/** 对下载失败的视频URL做一次轻量 HEAD 探活，返回状态码+来源，用于定位 403/签名过期等根因。 */
async function DL_HTTP_PROBE(videoUrl) {
  return new Promise((resolve) => {
    let s;
    try { s = new URL(videoUrl); } catch (e) { return resolve('invalid-url'); }
    const mod = s.protocol === 'https:' ? (require('https')) : (require('http'));
    const req = mod.request(s, { method: 'HEAD', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.douyin.com/' } }, (res) => {
      res.resume();
      resolve(`http-${res.statusCode} type=${res.headers['content-type'] || ''} len=${res.headers['content-length'] || '?'}`);
    });
    req.on('error', (e) => resolve(`error:${e.message}`));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
  });
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