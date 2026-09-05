/**
 * Download task manager — handles async video download tasks.
 *
 * Each task goes through: pending → downloading → completed/failed
 * Tasks are persisted in memory with TTL-based cleanup.
 */
const path = require('path');
const fs = require('fs');
const { generateId, sleep, estimateSizeMB, resolveCookiesFile } = require('../utils/helpers');
const { downloadVideo, isRetryableError } = require('./ytdlp');
const { runWatermarkRemoval, addTask, waitForTask } = require('./bridgeQueue');
const config = require('../config');

/** In-memory task store. */
const tasks = new Map();

/** Max concurrent downloads. */
let activeDownloads = 0;

/** Download directory. */
const DOWNLOAD_DIR = path.join(config.cacheDir, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/**
 * 取消某用户所有仍在"下载中"(in-flight)的旧任务，并删除已下载的旧目录。
 * 仅处理目标 userId 的任务，绝不触碰其他用户，避免误伤多人并发使用。
 * 用于：同用户提交新的下载/解析时，立即停掉自己旧的下载，独占带宽立刻跑新的。
 */
function cancelUserInFlight(userId) {
  if (!userId || userId === 'anonymous') return; // 无可靠标识不明文做顶替，宁可少取消不误杀
  for (const t of tasks.values()) {
    if (t.userId !== userId) continue; // 只动同用户
    if (t.status === 'downloading' && typeof t._kill === 'function') {
      console.log(`[downloader] 用户 ${t.userId} 提交了新任务，取消其旧任务 ${t.id}`);
      try { t._kill(); } catch {}
      t.status = 'cancelled';
      t.error = '已被该用户的新任务取代';
      // 删除旧任务已下载的目录，避免陈旧文件残留占用空间
      if (t.filePath) {
        try {
          const dir = path.dirname(t.filePath);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}

/** 每用户允许的在途下载任务数上限（含 downloading/queued/cancelled 之外的活动任务），防刷爆内存。 */
const MAX_USER_ACTIVE = 3;

/**
 * 统计某用户当前"仍在进行"的下载任务数（downloading 或 pending 排队中）。
 */
function countUserActive(userId) {
  let n = 0;
  for (const t of tasks.values()) {
    if (t.userId === userId && (t.status === 'downloading' || t.status === 'pending')) n++;
  }
  return n;
}

/** Create a download task with optional pre-populated info. */
function createTask(url, info = null, userId) {
  const taskId = generateId();
  const task = {
    id: taskId,
    url,
    userId: userId || 'anonymous',
    status: 'pending',
    progress: 0,
    title: info?.title || null,
    platform: info?.platform || null,
    directUrl: info?.directUrl || null,
    filePath: null,
    error: null,
    createdAt: Date.now(),
    _kill: null,
  };
  // 同用户提交新下载 → 立即取消其旧的仍在下载的任务（核心诉求：旧的马上停、立刻执行新任务）
  cancelUserInFlight(task.userId);
  // 单用户并发上限：同用户活动任务已达上限则拒绝，避免刷爆内存/带宽。
  if (userId && userId !== 'anonymous' && countUserActive(task.userId) > MAX_USER_ACTIVE) {
    task.status = 'cancelled';
    task.error = `下载任务过多，请等待当前任务完成后重试（单用户最多 ${MAX_USER_ACTIVE} 个）`;
    tasks.set(taskId, task);
    return task;
  }
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
    // 暴露底层下载进程句柄：供同用户新任务顶替时 kill 掉旧下载。
    downloadOptions.onSpawn = (proc) => {
      task._kill = () => { try { proc.kill('SIGTERM'); } catch {} };
    };
    if (task.directUrl) {
      downloadOptions.directUrl = task.directUrl;
    }
    // 按平台分发独立 cookie 文件（douyin/kuaishou/xiaohongshu/bilibili 等）。
    // 之前只针对 B站 硬编码 bilibili_cookies.txt；现用中央 helper 按 URL 选对应平台文件，
    // 无独立文件时回退共享 cookies.txt。
    if (task.url) {
      const cf = resolveCookiesFile(task.url);
      if (cf) downloadOptions.cookiesFile = cf;
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
    // 被同用户新任务顶替（cancelled）：立即停止，不再尝试。
    if (task.status === 'cancelled') {
      task._kill = null;
      return;
    }
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
      task._kill = null;
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
    // 抖音链路(yt-dlp+proxy)常被抖音风控概率性拒，直接判失败会让用户经常看到"所有下载方式均失败"。
    // 兜底：提交给 Edge 桥接扩展(从真实浏览器读登录态拿真实播放URL)，再下载，力求最终成功。
    if (task.status !== 'cancelled') {
      const bridgeSucceeded = await tryDouyinBridgeFallback(task, outputDir);
      if (!bridgeSucceeded) {
        console.error(`[downloader] 任务 ${taskId} 尝试 ${MAX_ATTEMPTS} 次后仍失败: ${lastErr?.message}`);
        task.status = 'failed';
        task.error = (lastErr?.message || '下载失败').slice(0, 500);
      }
    }
    task._kill = null;
  }

  activeDownloads--;
}

/**
 * 抖音下载失败的最终兜底：交给 Edge 桥接扩展拿真实播放URL并下载。
 * 返回 true 表示桥接兜底成功（task 已置 completed）。
 */
async function tryDouyinBridgeFallback(task, outputDir) {
  if (!task.url || !task.url.includes('douyin.com')) return false;
  if (!task || task.status === 'completed' || task.status === 'cancelled') return false; // 已完成或被顶替无需兜底

  console.log(`[downloader] 抖音直连失败，转桥接兜底: ${task.url.slice(0, 60)}...`);
  try {
    const { downloadFromUrl } = require('./ytdlp');
    const bridgeTaskId = addTask(task.url, task.userId);
    const res = await waitForTask(bridgeTaskId, 60000); // 等桥接返回真实播放URL(最多60s)
    if (!res || !res.videoUrl) {
      console.warn(`[downloader] 桥接兜底未拿到URL: ${task.url.slice(0, 50)}`);
      return false;
    }
    // 拿到桥接播放URL，直接下载到本地
    const bridgeOutput = path.join(outputDir, 'output.mp4');
    fs.mkdirSync(outputDir, { recursive: true });
    await downloadFromUrl(res.videoUrl, bridgeOutput, { sourceUrl: task.url, timeout: 120000 });
    task.filePath = bridgeOutput;
    task.status = 'completed';
    task.progress = 100;
    task.error = null;
    console.log(`[downloader] 桥接兜底下载成功: ${bridgeOutput}`);
    return true;
  } catch (e) {
    console.warn(`[downloader] 桥接兜底失败: ${e.message}`);
    return false;
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

/** Cleanup old completed/failed/cancelled tasks. */
function cleanup() {
  const now = Date.now();
  const ttlMs = config.completedTaskTTLSeconds * 1000;
  // 被顶替取消的任务是无用功，给更短 TTL，尽快释放内存/磁盘。
  const cancelledTtlMs = 60000;

  for (const [id, task] of tasks) {
    const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
    if (!isTerminal) continue;
    const ttl = task.status === 'cancelled' ? cancelledTtlMs : ttlMs;
    if (now - task.createdAt <= ttl) continue;
    // Delete output dir（无论 filePath 是否已设置，DELETE_DIR/taskId 可能残留）
    let dir = null;
    if (task.filePath) {
      dir = path.dirname(task.filePath);
    } else if (task.id) {
      dir = path.join(DOWNLOAD_DIR, task.id);
    }
    if (dir && fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir);
      } catch {}
    }
    tasks.delete(id);
  }
}

/** Start periodic cleanup. */
function startCleanup() {
  setInterval(cleanup, config.taskCleanupIntervalSeconds * 1000);
}

module.exports = { createTask, getTask, getTaskFile, getTaskFileFromDisk, startCleanup };