/**
 * Video API routes.
 *
 * - POST /api/video/info  - Parse video metadata
 * - POST /api/video/download - Create download task
 * - GET  /api/video/task/:id  - Get task status
 * - GET  /api/video/file/:id  - Get downloaded file
 * - GET  /api/video/platforms  - List supported platforms
 * - POST /api/video/album/info  - Parse album/image note info
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const router = express.Router();

const { getVideoInfo, downloadVideo, extractWithPython } = require('../services/ytdlp');
const { getPlayInfo, extractVideoId, isDoubaoUrl } = require('../services/doubao');
const { getVideoInfo: getKuaishouInfo } = require('../services/kuaishou');
const { createTask, getTask, getTaskFile, getTaskFileFromDisk, startCleanup } = require('../services/downloader');
const { extractVideo: playwrightExtract } = require('../services/playwrightService');
const bridgeQueue = require('../services/bridgeQueue');
const config = require('../config');
const { generateId, detectPlatform, formatDuration } = require('../utils/helpers');

/** Max duration in seconds for auto-download (25 minutes). */
const MAX_DURATION_SECONDS = 1500;

/** Ensure a URL uses HTTPS (replace HTTP). */
function ensureHttps(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/^http:\/\//i, 'https://');
}

/** Health check. */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** List supported platforms. */
router.get('/platforms', (req, res) => {
  res.json({
    platforms: [
      { key: 'douyin', name: '抖音', desc: '支持抖音短视频、中视频' },
      { key: 'kuaishou', name: '快手', desc: '支持快手短视频' },
      { key: 'xiaohongshu', name: '小红书', desc: '支持小红书视频笔记' },
      { key: 'bilibili', name: 'B站', desc: '支持哔哩哔哩视频' },
      { key: 'tiktok', name: 'TikTok', desc: '支持TikTok短视频' },
      { key: 'youtube', name: 'YouTube', desc: '支持YouTube视频' },
      { key: 'doubao', name: '豆包', desc: '支持豆包AI视频' },
      { key: 'jimeng', name: '即梦', desc: '支持即梦AI视频' },
      { key: 'weibo', name: '微博', desc: '支持微博视频下载' },
    ],
  });
});

/** Parse video info AND start download simultaneously. */
router.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供视频链接', field: 'url' });
  }

  // For platforms that may need the browser extension bridge,
  // try direct parsing first (yt-dlp / doubao API), then fall back to bridge
  const { platform: platKey, label: platLabel, needsBridge } = detectPlatform(url);

  // 抖音：yt-dlp 被抖音概率性风控(~80%拒, 即使含sessionid)，Playwright 也不稳。
  // 直接优先走 Edge 桥接(真实浏览器读登录态拿播放URL，几乎100%成功)，跳过不稳直连链路。
  if (platKey === 'douyin') {
    console.log(`[info] 抖音直接走桥接: ${url.slice(0, 50)}...`);
    const bridgeTaskId = bridgeQueue.addTask(url, req.headers['x-user-id']);
    return res.json({
      success: true,
      data: {
        title: '正在解析中...',
        author: '',
        duration: 0,
        durationFormatted: '0:00',
        thumbnailUrl: null,
        platform: '抖音',
        videoId: '',
        webpageUrl: url,
        directUrl: null,
        hasOriginal: false,
        taskId: bridgeTaskId,
        bridgeTip: '正在通过浏览器解析，请稍候...',
      },
    });
  }

  if (needsBridge) {
    try {
      let info;
      if (platKey === 'doubao') {
        const videoId = extractVideoId(url);
        if (!videoId) throw new Error('无法从链接中提取 video_id');
        info = await getPlayInfo(videoId);
      } else if (platKey === 'kuaishou' || platKey === 'weibo') {
        // 先尝试 Playwright 无头浏览器提取
        try {
          const pwResult = await playwrightExtract(url, { timeout: 30000 });
          if (pwResult && pwResult.videoUrl) {
            info = {
              title: pwResult.title || (platKey === 'kuaishou' ? '快手视频' : '微博视频'),
              author: '',
              duration: 0,
              thumbnailUrl: null,
              directUrl: pwResult.videoUrl,
              platformLabel: platKey === 'kuaishou' ? '快手' : '微博',
              videoId: '',
              webpageUrl: url,
              hasOriginal: false,
            };
          } else {
            throw new Error('Playwright 未能提取到视频');
          }
        } catch (pwErr) {
          console.log(`[info] Playwright failed for ${platLabel}: ${pwErr.message}, falling back to bridge`);
          throw new Error(`${platLabel}需要浏览器辅助解析`);
        }
      } else {
        info = await getVideoInfo(url);
      }
      // 解析成功，检查时长
      if (info.duration > MAX_DURATION_SECONDS) {
        return res.json({
          success: true,
          data: {
            title: info.title,
            author: info.author,
            duration: info.duration,
            durationFormatted: formatDuration(info.duration),
            thumbnailUrl: ensureHttps(info.thumbnailUrl),
            platform: info.platformLabel || platLabel,
            videoId: info.videoId,
            webpageUrl: info.webpageUrl,
            directUrl: info.directUrl,
            hasOriginal: info.hasOriginal,
            tooLong: true,
            message: '视频时长超过25分钟，当前工具仅支持25分钟以内的视频下载',
          },
        });
      }

      // 检查通过，创建下载任务（后台开始下载）
      const task = createTask(url, {
        title: info.title,
        platform: info.platformLabel || platLabel,
        directUrl: info.directUrl || null,
      }, req.headers['x-user-id']);
      return res.json({
        success: true,
        data: {
          title: info.title,
          author: info.author,
          duration: info.duration,
          durationFormatted: formatDuration(info.duration),
          thumbnailUrl: ensureHttps(info.thumbnailUrl),
          platform: info.platformLabel || platLabel,
          videoId: info.videoId,
          webpageUrl: info.webpageUrl,
          directUrl: info.directUrl,
          hasOriginal: info.hasOriginal,
          taskId: task.id,
        },
      });
    } catch (err) {
      console.log(`[info] ${platLabel} direct parsing failed: ${err.message}, trying Playwright...`);
      // 尝试 Playwright 无头浏览器提取
      try {
        const pwResult = await playwrightExtract(url, { timeout: 30000 });
        if (pwResult && pwResult.videoUrl) {
          console.log(`[info] Playwright extracted video URL for ${platLabel}`);
          const task = createTask(url, {
            title: pwResult.title || platLabel + '视频',
            platform: platLabel,
            directUrl: pwResult.videoUrl,
          }, req.headers['x-user-id']);
          return res.json({
            success: true,
            data: {
              title: pwResult.title || platLabel + '视频',
              author: '',
              duration: 0,
              durationFormatted: '0:00',
              thumbnailUrl: null,
              platform: platLabel,
              videoId: '',
              webpageUrl: url,
              directUrl: pwResult.videoUrl,
              hasOriginal: true,
              taskId: task.id,
            },
          });
        }
      } catch (pwErr) {
        console.log(`[info] Playwright also failed: ${pwErr.message}`);
      }

      // 最后回退到桥接扩展
      console.log(`[info] Falling back to bridge extension for ${platLabel}`);
      const taskId = bridgeQueue.addTask(url, req.headers['x-user-id']);
      console.log(`[bridge] Queued task during info: ${taskId} for ${url.slice(0, 60)}...`);
      return res.json({
        success: true,
        data: {
          title: '正在解析中...',
          author: '',
          duration: 0,
          durationFormatted: '0:00',
          thumbnailUrl: null,
          platform: platLabel,
          videoId: '',
          webpageUrl: url,
          directUrl: null,
          hasOriginal: false,
          taskId,
          bridgeTip: '正在通过浏览器解析，请稍候...',
        },
      });
    }
  }

  try {
    const info = await getVideoInfo(url);

    // 检查时长
    if (info.duration > MAX_DURATION_SECONDS) {
      return res.json({
        success: true,
        data: {
          title: info.title,
          author: info.author,
          duration: info.duration,
          durationFormatted: formatDuration(info.duration),
          thumbnailUrl: ensureHttps(info.thumbnailUrl),
          platform: info.platformLabel,
          videoId: info.videoId,
          webpageUrl: info.webpageUrl,
          directUrl: info.directUrl,
          hasOriginal: info.hasOriginal,
          tooLong: true,
          message: '视频时长超过25分钟，当前工具仅支持25分钟以内的视频下载',
        },
      });
    }

    // 检查通过，创建下载任务（后台开始下载）
    const task = createTask(url, {
      title: info.title,
      platform: info.platformLabel,
      directUrl: info.directUrl || null,
    }, req.headers['x-user-id']);
    res.json({
      success: true,
      data: {
        title: info.title,
        author: info.author,
        duration: info.duration,
        durationFormatted: formatDuration(info.duration),
        thumbnailUrl: ensureHttps(info.thumbnailUrl),
        platform: info.platformLabel,
        videoId: info.videoId,
        webpageUrl: info.webpageUrl,
        directUrl: info.directUrl,
        hasOriginal: info.hasOriginal,
        taskId: task.id,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Create download task. */
router.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供视频链接', field: 'url' });
  }

  // Bridge-requiring platforms - try direct parsing first
  const { platform: platKey, label: platLabel, needsBridge } = detectPlatform(url);

  if (needsBridge) {
    try {
      let info;

      // 抖音：yt-dlp 直连被风控概率性拒，直接走 Edge 桥接（如 /info 一样一键直达），
      // 跳过注定失败的 yt-dlp 尝试与相应超时。
      if (platKey === 'douyin') {
        const taskId = bridgeQueue.addTask(url, req.headers['x-user-id']);
        console.log(`[bridge] 抖音下载直接走桥接: ${url.slice(0, 50)}... -> ${taskId}`);
        return res.json({
          success: true,
          data: {
            id: taskId,
            title: '等待浏览器处理...',
            platform: '抖音',
            status: 'downloading',
            progress: 0,
            bridgeTip: '正在通过浏览器解析，请稍候...',
          },
        });
      }

      if (platKey === 'doubao') {
        const videoId = extractVideoId(url);
        if (!videoId) throw new Error('无法从链接中提取 video_id');
        info = await getPlayInfo(videoId);
      } else if (platKey === 'kuaishou' || platKey === 'weibo') {
        info = platKey === 'kuaishou' ? await getKuaishouInfo(url) : await getVideoInfo(url);
      } else {
        info = await getVideoInfo(url);
      }

      // If yt-dlp got metadata but no direct URL (common for Xiaohongshu),
      // fall back to bridge queue for actual download
      if (!info.directUrl && (platKey === 'xiaohongshu' || platKey === 'kuaishou')) {
        console.log(`[bridge] ${platLabel} has no direct URL, falling back to bridge`);
        throw new Error('无直接下载地址，需要浏览器辅助');
      }

      const task = createTask(url, {
        title: info.title,
        platform: info.platformLabel || platLabel,
        directUrl: info.directUrl || null,
      }, req.headers['x-user-id']);
      return res.json({
        success: true,
        data: {
          id: task.id,
          title: task.title,
          platform: task.platform,
          status: task.status,
          progress: task.progress,
        },
      });
    } catch (err) {
      // 尝试 Playwright 无头浏览器
      try {
        const pwResult = await playwrightExtract(url, { timeout: 25000 });
        if (pwResult && pwResult.videoUrl) {
          console.log(`[playwright] Download extracted for ${platLabel}`);
          const task = createTask(url, {
            title: pwResult.title || platLabel + '视频',
            platform: platLabel,
            directUrl: pwResult.videoUrl,
          }, req.headers['x-user-id']);
          return res.json({
            success: true,
            data: {
              id: task.id,
              title: task.title,
              platform: task.platform,
              status: task.status,
              progress: task.progress,
            },
          });
        }
      } catch (pwErr) {
        console.log(`[playwright] Download fallback failed: ${pwErr.message}`);
      }

      // Fall back to bridge queue
      const taskId = bridgeQueue.addTask(url);
      console.log(`[bridge] Download queued for ${platLabel}: ${url.slice(0, 60)}...`);
      return res.json({
        success: true,
        data: {
          id: taskId,
          title: '等待浏览器处理...',
          platform: platLabel,
          status: 'downloading',
          progress: 0,
          bridgeTip: '正在通过浏览器解析，请稍候...',
        },
      });
    }
  }

  try {
    // First get video info to populate task metadata
    const info = await getVideoInfo(url);

    const task = createTask(url, {
      title: info.title,
      platform: info.platformLabel,
      directUrl: info.directUrl || null,
    }, req.headers['x-user-id']);

    res.json({
      success: true,
      data: {
        id: task.id,
        title: task.title,
        platform: task.platform,
        status: task.status,
        progress: task.progress,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Get download task status. */
router.get('/task/:id', (req, res) => {
  const taskId = req.params.id;

  // Check bridge queue first
  if (taskId.startsWith('bridge_')) {
    const bridgeTask = bridgeQueue.getTask(taskId);
    if (bridgeTask) {
      const { label: platLabel } = detectPlatform(bridgeTask.url);

      // Bridge task timeout: 5 minutes
      const BRIDGE_TASK_TIMEOUT = 300000;
      if (bridgeTask.status !== 'completed' && bridgeTask.status !== 'failed' && Date.now() - bridgeTask.createdAt > BRIDGE_TASK_TIMEOUT) {
        bridgeTask.status = 'failed';
        bridgeTask.error = '桥接解析超时，请确保浏览器扩展（桥接扩展）已安装并运行';
      }

      return res.json({
        id: bridgeTask.taskId,
        status: bridgeTask.status === 'completed' ? 'completed' : bridgeTask.status === 'failed' ? 'failed' : 'downloading',
        progress: bridgeTask.status === 'completed' ? 100 : bridgeTask.status === 'downloading' ? 50 : 0,
        title: bridgeTask.status === 'downloading' ? '正在下载到服务器...' : '等待浏览器处理...',
        platform: platLabel,
        filePath: bridgeTask.result || null,
        error: bridgeTask.error || null,
      });
    }
    return res.status(404).json({ error: '任务不存在或已过期' });
  }

  const task = getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }
  res.json(task);
});

/** Get downloaded video file. */
router.get('/file/:id', async (req, res) => {
  const taskId = req.params.id;

  // Check if it's a bridge task with a video URL
  if (taskId.startsWith('bridge_')) {
    const bridgeTask = bridgeQueue.getTask(taskId);
    if (bridgeTask && bridgeTask.result) {
      // 等待本地下载完成（最多等30秒），优先使用本地文件
      const serveLocalFile = async () => {
        if (bridgeTask._downloadPromise) {
          try {
            await Promise.race([
              bridgeTask._downloadPromise,
              new Promise(r => setTimeout(r, 30000)),
            ]);
          } catch {}
        }
        if (bridgeTask.localFilePath && fs.existsSync(bridgeTask.localFilePath)) {
          console.log(`[file] Serving bridge video from local file: ${bridgeTask.localFilePath}`);
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.sendFile(bridgeTask.localFilePath);
        }
        return false;
      };

      const served = await serveLocalFile();
      if (served !== false) return;

      // Fallback: stream directly from CDN
      console.log(`[proxy] Streaming bridge video directly from CDN`);
      try {
        const videoUrl = bridgeTask.result;
        const mod = videoUrl.startsWith('https') ? https : http;
        mod.get(videoUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.kuaishou.com/',
          },
          timeout: 120000,
        }, (proxyRes) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
          res.setHeader('Content-Length', proxyRes.headers['content-length'] || '');
          proxyRes.pipe(res);
        }).on('error', (err) => {
          console.error(`[proxy] Bridge video error: ${err.message}`);
          res.status(502).json({ error: '视频代理失败' });
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }
    return res.status(404).json({ error: '视频文件不存在或未完成' });
  }

  const filePath = getTaskFile(taskId) || getTaskFileFromDisk(taskId);
  if (!filePath) {
    return res.status(404).json({ error: '视频文件不存在或未完成' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件已过期' });
  }
  res.sendFile(filePath);
});

/**
 * 获取下载文件信息（大小），用于小程序判断走 Worker 还是直连。
 * GET /api/video/file-info/:id
 */
router.get('/file-info/:id', async (req, res) => {
  const taskId = req.params.id;

  // bridge 任务：文件由桥接扩展回报后经 ffmpeg 落盘，存于 bridgeQueue 任务而非 downloader 任务表。
  // 需等待本地下载完成（最多 ~25s），再按 localFilePath 返回。
  if (String(taskId).startsWith('bridge_')) {
    const bridgeTask = bridgeQueue.getTask(taskId);
    if (!bridgeTask || !bridgeTask.result) {
      return res.status(404).json({ error: '视频文件不存在或未完成' });
    }
    if (bridgeTask._downloadPromise) {
      try {
        await Promise.race([
          bridgeTask._downloadPromise,
          new Promise(r => setTimeout(r, 25000)),
        ]);
      } catch {}
    }
    const bPath = bridgeTask.localFilePath;
    if (!bPath || !fs.existsSync(bPath)) {
      return res.status(404).json({ error: '视频文件不存在或未完成' });
    }
    const bStat = fs.statSync(bPath);
    const bSizeMB = Math.round(bStat.size / 1024 / 1024 * 100) / 100;
    return res.json({
      size: bStat.size,
      sizeMB: bSizeMB,
      needCompress: bStat.size > 80 * 1024 * 1024,
    });
  }

  // 优先从内存任务取，任务已清理则从磁盘取
  let filePath = getTaskFile(taskId) || getTaskFileFromDisk(taskId);
  if (!filePath) {
    return res.status(404).json({ error: '视频文件不存在或未完成' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件已过期' });
  }
  const stat = fs.statSync(filePath);
  const sizeMB = Math.round(stat.size / 1024 / 1024 * 100) / 100;
  res.json({
    size: stat.size,
    sizeMB,
    // 超过 80MB 需要压缩画质（避开 Cloudflare Worker 100MB 限制）
    needCompress: stat.size > 80 * 1024 * 1024,
  });
});

/**
 * 压缩下载（大文件 >80MB 时用 ffmpeg 压缩到 <80MB）。
 * 压缩版缓存到磁盘，避免重复压缩。
 * GET /api/video/file-compressed/:id
 */
router.get('/file-compressed/:id', async (req, res) => {
  const taskId = req.params.id;
  const filePath = getTaskFile(taskId) || getTaskFileFromDisk(taskId);
  if (!filePath) {
    return res.status(404).json({ error: '视频文件不存在或未完成' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件已过期' });
  }

  // 小于 80MB 的文件无需压缩，直接返回原文件
  const originSize = fs.statSync(filePath).size;
  if (originSize <= 80 * 1024 * 1024) {
    return res.sendFile(filePath);
  }

  // 压缩缓存目录
  const compressedDir = path.join(config.cacheDir, 'compressed');
  fs.mkdirSync(compressedDir, { recursive: true });
  const compressedPath = path.join(compressedDir, `${taskId}.mp4`);

  try {
    // 已有压缩缓存，直接返回
    if (fs.existsSync(compressedPath) && fs.statSync(compressedPath).size > 1000) {
      console.log(`[compress] Serving cached compressed file: ${compressedPath}`);
      return res.sendFile(compressedPath);
    }

    // 用 ffprobe 获取时长，计算目标码率（目标 ~75MB）
    const duration = await getVideoDuration(filePath);
    const targetBits = 75 * 1024 * 1024 * 8; // 75MB → bits
    let videoBitrate = 1200; // 默认 1.2Mbps，如果时长为 0
    if (duration > 0) {
      // 视频码率 = 总目标码率 - 音频码率(96k) - 容器开销
      const totalKbps = targetBits / duration / 1000;
      videoBitrate = Math.max(200, Math.floor(totalKbps * 0.9 - 96));
    }

    console.log(`[compress] Compressing ${filePath} (duration=${duration}s, bitrate=${videoBitrate}k)`);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { spawn } = require('child_process');
    const args = [
      '-y',
      '-i', filePath,
      '-c:v', 'libx264',
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.floor(videoBitrate * 1.2)}k`,
      '-bufsize', `${Math.floor(videoBitrate * 2)}k`,
      '-c:a', 'aac',
      '-b:a', '96k',
      '-vf', "scale='min(1280,iw)':-2",
      '-movflags', '+faststart',
      compressedPath,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(compressedPath)) {
        console.log(`[compress] Done: ${compressedPath} (${fs.statSync(compressedPath).size} bytes)`);
        res.sendFile(compressedPath);
      } else {
        console.error(`[compress] Failed: ${stderr.slice(-300)}`);
        // 压缩失败，回退返回原文件
        res.sendFile(filePath);
      }
    });

    proc.on('error', (err) => {
      console.error(`[compress] spawn error: ${err.message}`);
      res.sendFile(filePath);
    });
  } catch (err) {
    console.error(`[compress] Error: ${err.message}`);
    res.sendFile(filePath);
  }
});

/** 用 ffprobe 获取视频时长（秒） */
function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(0);
      const d = parseFloat(stdout.toString().trim());
      resolve(isNaN(d) ? 0 : d);
    });
  });
}

/**
 * 公网直连下载（绕过 Cloudflare Worker 100MB 限制）。
 * 支持 HTTP Range 断点续传。
 * GET /api/video/file-direct/:id
 */
router.get('/file-direct/:id', (req, res) => {
  const taskId = req.params.id;
  // 优先从内存任务取，任务已清理则从磁盘取
  let filePath = getTaskFile(taskId) || getTaskFileFromDisk(taskId);
  if (!filePath) {
    return res.status(404).json({ error: '视频文件不存在或未完成' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件已过期' });
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  // 允许跨域
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 支持 Range 请求（断点续传 / 分片下载）
  if (range) {
    const matches = range.match(/bytes=(\d+)-(\d*)/);
    if (matches) {
      const start = parseInt(matches[1], 10);
      const end = matches[2] ? parseInt(matches[2], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      if (start >= stat.size || start > end) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.status(206);
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }

  // 完整下载
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  fs.createReadStream(filePath).pipe(res);
});

/**
 * External video URL from browser extension bridge.
 * The extension captures Douyin video URLs and sends them here.
 */
router.post('/external', (req, res) => {
  const { videoUrl, filename } = req.body;
  if (!videoUrl) {
    return res.status(400).json({ error: '请提供视频URL' });
  }

  console.log(`[external] Received video URL from extension: ${videoUrl.slice(0, 80)}...`);

  try {
    const externalDir = path.join(config.cacheDir, 'external');
    fs.mkdirSync(externalDir, { recursive: true });
    const record = {
      url: videoUrl,
      filename: filename || 'unknown',
      timestamp: Date.now(),
    };
    const recordPath = path.join(externalDir, `${Date.now()}.json`);
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.log(`[external] Saved to ${recordPath}`);
  } catch (e) {
    console.error(`[external] Save error: ${e.message}`);
  }

  res.json({ success: true });
});

/**
 * Browser extension bridge - queue for video parsing requests.
 * Mini program submits URLs here, extension polls for new tasks.
 */
/** Submit a URL for the browser extension to parse */
router.post('/bridge/parse', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: '请提供视频链接' });
  }

  const taskId = bridgeQueue.addTask(url, req.headers['x-user-id']);
  console.log(`[bridge] Queued parse task: ${taskId} for ${url.slice(0, 60)}...`);
  res.json({ success: true, taskId });
});

/** Extension polls for pending tasks */
router.get('/bridge/tasks', (req, res) => {
  bridgeQueue.cleanup();
  const pending = bridgeQueue.getNextPendingTask();
  if (pending) {
    // 把 taskType(image/video) 一并返回给扩展，否则扩展拿不到类型会把图文误当视频处理。
    return res.json({ hasTask: true, taskId: pending.taskId, url: pending.url, taskType: pending.taskType || 'video' });
  }
  res.json({ hasTask: false });
});

/** Extension reports result back */
router.post('/bridge/result', (req, res) => {
  const { taskId, videoUrl, error, images } = req.body;
  const task = bridgeQueue.reportResult(taskId, videoUrl, error, images);
  if (task) {
    console.log(`[bridge] Task ${taskId} got ${Array.isArray(images) && images.length ? 'images ' + images.length : (videoUrl ? 'video URL' : 'FAILED')}`);
  }
  res.json({ success: true });
});

/** Mini program checks task status */
router.get('/bridge/status/:taskId', (req, res) => {
  const task = bridgeQueue.getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json({
    taskId: task.taskId,
    status: task.status,
    videoUrl: task.result,
    images: task.images || [],
    error: task.error,
  });
});

/**
 * Sync download for quick use (no async polling).
 * Used when user just wants a quick download.
 */
router.post('/download/sync', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供视频链接' });
  }

  try {
    const taskId = generateId();
    const outputDir = path.join(config.cacheDir, 'sync_downloads', taskId);
    fs.mkdirSync(outputDir, { recursive: true });

    // Get video info to get direct URL if available
    const info = await getVideoInfo(url);
    const downloadOptions = {};
    if (info.directUrl) {
      downloadOptions.directUrl = info.directUrl;
    }

    const result = await downloadVideo(url, outputDir, downloadOptions);

    // Serve the file
    res.sendFile(result.filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Video proxy for preview - streams the video through our server.
 * This allows the mini program to play the video (domain whitelist).
 * GET /api/video/proxy?url={encodedVideoUrl}
 */
router.get('/proxy', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: '请提供视频URL' });
  }

  console.log(`[proxy] Streaming video: ${videoUrl.slice(0, 80)}...`);

  try {
    // Use http or https based on the URL
    const mod = videoUrl.startsWith('https') ? https : http;
    mod.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.douyin.com/',
      },
      timeout: 30000,
    }, (proxyRes) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
      res.setHeader('Content-Length', proxyRes.headers['content-length'] || '');
      res.setHeader('Accept-Ranges', 'bytes');
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error(`[proxy] Error: ${err.message}`);
      res.status(502).json({ error: '视频代理失败' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start cleanup timer when routes are loaded
startCleanup();

/**
 * Image proxy — relays thumbnail images through server to avoid CDN hotlink blocking.
 * GET /api/video/image?url={encodedImageUrl}
 */
router.get('/image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ error: '请提供图片URL' });

  try {
    const mod = imageUrl.startsWith('https') ? https : http;
    // 根据图片域名动态设置 Referer（抖音/小红书防盗链要求不同的 Referer）
    let referer = 'https://www.xiaohongshu.com/';
    if (imageUrl.includes('douyinpic.com') || imageUrl.includes('douyincdn.com') || imageUrl.includes('bytedance')) {
      referer = 'https://www.douyin.com/';
    } else if (imageUrl.includes('xiaohongshu') || imageUrl.includes('xhscdn')) {
      referer = 'https://www.xiaohongshu.com/';
    }
    mod.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer,
      },
      timeout: 20000,
    }, (proxyRes) => {
      // 收集图片字节，判断格式；WebP 等小程序不支持的格式用 ffmpeg 转成 JPEG
      const chunks = [];
      let size = 0;
      proxyRes.on('data', c => { chunks.push(c); size += c.length; });
      proxyRes.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = proxyRes.headers['content-type'] || '';
        const isWebp = ct.includes('webp') || (buf.length > 11 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');

        if (!isWebp) {
          // 非 WebP 直接透传
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', ct || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.end(buf);
        }

        // WebP → JPEG（小程序部分系统不支持 WebP 显示）
        const { spawn } = require('child_process');
        const ff = spawn('ffmpeg', ['-y', '-i', '-', '-f', 'image2', '-q:v', '2', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const outChunks = [];
        ff.stdout.on('data', c => outChunks.push(c));
        ff.on('close', (code) => {
          if (code === 0 && outChunks.length > 0) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(Buffer.concat(outChunks));
          } else {
            // 转换失败则回退返回原始 WebP（至少前端能尝试）
            console.warn(`[image-proxy] WebP转JPEG失败, code=${code}`);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(buf);
          }
        });
        ff.stdin.write(buf);
        ff.stdin.end();
      });
    }).on('error', (err) => {
      console.error(`[image-proxy] Error: ${err.message}`);
      res.status(502).json({ error: '图片代理失败' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Debug endpoint: test Doubao API connectivity.
 */
router.get('/debug/doubao', async (req, res) => {
  const { getPlayInfo, extractVideoId } = require('../services/doubao');
  const config = require('../config');
  const path = require('path');
  const fs = require('fs');

  const diagnostics = {};

  // 1. Check cookies.txt
  const cookiesPaths = [
    path.join(config.projectDir, 'cookies.txt'),
    path.join(config.serverDir, 'cookies.txt'),
  ];
  diagnostics.cookies = { paths: cookiesPaths, found: false };
  for (const cp of cookiesPaths) {
    const exists = fs.existsSync(cp);
    diagnostics.cookies[cp] = exists;
    if (exists) {
      diagnostics.cookies.found = true;
      const stat = fs.statSync(cp);
      diagnostics.cookies.lastModified = stat.mtime.toISOString();
      diagnostics.cookies.sizeBytes = stat.size;
      // 检查 cookie 数量
      const content = fs.readFileSync(cp, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      diagnostics.cookies.cookieCount = lines.length;
      // 检查是否过期
      const now = Date.now() / 1000;
      let expiredCount = 0;
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 7) {
          const expiry = parseInt(parts[4], 10);
          if (!isNaN(expiry) && expiry < now) expiredCount++;
        }
      }
      diagnostics.cookies.expiredCount = expiredCount;
    }
  }

  // 2. Test API with a sample video ID if provided
  const testVideoId = req.query.video_id;
  if (testVideoId) {
    try {
      diagnostics.apiTest = { status: 'testing', videoId: testVideoId };
      const result = await getPlayInfo(testVideoId);
      diagnostics.apiTest = {
        status: 'success',
        videoId: testVideoId,
        hasDirectUrl: !!result.directUrl,
        title: result.title,
        width: result.width,
        height: result.height,
      };
    } catch (e) {
      diagnostics.apiTest = {
        status: 'failed',
        videoId: testVideoId,
        error: e.message,
      };
    }
  }

  res.json({ success: true, diagnostics });
});

/**
 * Parse album/image note info (Xiaohongshu / Douyin image notes).
 * Returns title, description, author, and image list.
 */
router.post('/album/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供笔记链接', field: 'url' });
  }

  const { platform: platKey, label: platLabel } = detectPlatform(url);
  if (platKey !== 'xiaohongshu' && platKey !== 'douyin') {
    return res.status(400).json({ error: `暂不支持 ${platLabel} 的图文解析` });
  }

  // 抖音图文不依赖 Edge 桥接，回退用 Python/Playwright 提取器（与小红书一致，同步返回图片列表）。
  try {
    let result = null;
    // 小红书/抖音图文都走提取器（带网络/SSL 抖动自动重试），只这一处收敛图文逻辑，其他功能不动。
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (platKey === 'xiaohongshu') {
          // Xiaohongshu: use Playwright dedicated album extraction
          result = await extractXiaohongshuAlbum(url);
        } else {
          // Douyin: use Python extractor (supports image notes)
          const py = await extractWithPython(url);
          if (!py || py.error) throw new Error(py?.error || 'Python 提取失败');
          const imgs = (py.images || []).filter(Boolean).map(u => (u && u.startsWith('//')) ? 'https:' + u : u);
          result = {
            title: (py.title || 'Untitled').slice(0, 200),
            author: py.author || '',
            description: py.description || '',
            platform: py.platform || platLabel,
            contentType: imgs.length > 0 ? 'image_set' : 'video',
            imageCount: imgs.length,
            images: imgs.map((iv, idx) => ({ url: iv, index: idx })),
            hasVideo: !!py.video_url,
            videoUrl: py.video_url || null,
          };
        }
        lastErr = null;
        break; // 成功
      } catch (e) {
        lastErr = e;
        // 只对网络/SSL/空结果类抖动重试；已经是平台逻辑错误(如"暂不支持")则立即失败。
        const transient = (e.message || '').match(/network|eof|ssl|reset|timeout|超时|连接|captcha|401|403|412|429|429|timed out/i);
        if (attempt < 3 && (transient || !result)) {
          await new Promise(r => setTimeout(r, attempt * 1200));
          continue;
        }
        throw e;
      }
    }
    if (lastErr) throw lastErr;

    if (result && result.title) {
      result.title = result.title.replace(/[\uD800-\uDFFF]/g, '').replace(/�/g, '');
    }
    if (result && result.description) {
      result.description = result.description.replace(/[\uD800-\uDFFF]/g, '').replace(/�/g, '');
    }
    res.json({ success: true, data: cleanSurrogates(result) });
    console.log(`[album] response sent for ${platLabel}, images=${result.imageCount || 0}`);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** 清洗字符串中的无效 UTF-16 代理对（surrogate pair），避免小程序显示乱码 */
function cleanSurrogates(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/[\uD800-\uDFFF]/g, '');
  }
  if (Array.isArray(obj)) {
    return obj.map(cleanSurrogates);
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = cleanSurrogates(v);
    }
    return out;
  }
  return obj;
}

/**
 * 小红书图文笔记提取 — 纯 HTTP 解析 window.__INITIAL_STATE__。
 * 参考成熟方案：先请求短链获取完整 URL（含note_id），再从页面HTML解析内嵌数据。
 */
async function extractXiaohongshuAlbum(url) {
  // 小某书无需 cookies 也能在页面 HTML 里拿到 __INITIAL_STATE__（登录态反而可能触发风控跳转）
  // 若需要完整数据可尝试附带 cookies，先以无 cookies 为主

  // 2. 请求完整页面 HTML（自动跟随重定向短链→真实笔记页），解析 __INITIAL_STATE__
  const html = await httpGetText(url, '', true);
  const state = parseInitialState(html);
  if (!state) throw new Error('没有找到小红书笔记初始数据，链接可能过期或页面结构已变化');

  // 3. 从 noteDetailMap 找到目标笔记
  const noteMap = state?.note?.noteDetailMap || {};
  let note = null;
  for (const key of Object.keys(noteMap)) {
    note = noteMap[key]?.note;
    if (note) break;
  }
  if (!note) {
    const firstNoteId = state?.note?.firstNoteId;
    note = (firstNoteId && noteMap[firstNoteId]?.note) || Object.values(noteMap)[0]?.note;
  }
  if (!note) throw new Error('没有找到小红书笔记详情');

  // 4. 提取图片（imageList[].infoList[].url，优先高清）
  const images = [];
  const imageList = note.imageList || note.images || [];
  for (const img of imageList) {
    if (!img) continue;
    let bestUrl = '';
    for (const info of (img.infoList || [])) {
      if (info?.url) bestUrl = info.url; // 取最后一个（通常对应高清）
    }
    if (!bestUrl) bestUrl = img.urlDefault || img.url || '';
    if (bestUrl && !bestUrl.includes('fix=.png')) images.push(bestUrl);
  }

  // 5. 提取文案和作者
  const desc = note.desc || note.title || '';
  const author = note.user?.nickname || note.author || '';
  const title = (note.title?.trim() || (desc || '').split('\n')[0]?.trim() || '小红书笔记').slice(0, 200);

  return {
    title,
    author: author || '',
    description: desc || '',
    platform: '小红书',
    contentType: images.length > 0 ? 'image_set' : 'video',
    imageCount: images.length,
    images: images.map((u, idx) => ({ url: u, index: idx })),
    hasVideo: !!note.video,
    videoUrl: note.video?.media?.[0]?.url || note.video?.url || null,
  };
}

/** HTTP GET 返回文本，自动跟随重定向（最多5跳，类似 curl -L） */
function httpGetText(url, cookieHeader, followRedirect = true, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return resolve(''); // 重定向过多次，放弃
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookieHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.xiaohongshu.com/',
      },
      timeout: 25000,
    }, (res) => {
      // 处理重定向
      if (followRedirect && res.statusCode >= 300 && res.statusCode < 400 && res.headers?.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).href;
        return resolve(httpGetText(nextUrl, cookieHeader, followRedirect, depth + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', (err) => reject(new Error(`请求小红书失败: ${err.message}`)));
  });
}

/** 从 HTML 解析 window.__INITIAL_STATE__ 为 JSON 对象 */
function parseInitialState(html) {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = html.indexOf('{', start + marker.length);
  if (jsonStart < 0) return null;
  const jsonEnd = findMatchingBrace(html, jsonStart);
  if (jsonEnd < 0) return null;
  const raw = html.substring(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(raw);
  } catch {
    // 处理 JSON 里的 JS 字面量（undefined 等）
    try {
      return JSON.parse(raw.replace(/\bundefined\b/g, 'null'));
    } catch { return null; }
  }
}

/** 找到匹配的右花括号 */
function findMatchingBrace(text, openingIndex) {
  let depth = 0, inString = false, quote = '', escaped = false;
  for (let i = openingIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; }
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
    return -1;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

module.exports = router;