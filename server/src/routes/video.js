/**
 * Video API routes.
 *
 * - POST /api/video/info  - Parse video metadata
 * - POST /api/video/download - Create download task
 * - GET  /api/video/task/:id  - Get task status
 * - GET  /api/video/file/:id  - Get downloaded file
 * - GET  /api/video/platforms  - List supported platforms
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const router = express.Router();

const { getVideoInfo, downloadVideo } = require('../services/ytdlp');
const { getPlayInfo, extractVideoId, isDoubaoUrl } = require('../services/doubao');
const { createTask, getTask, getTaskFile, startCleanup } = require('../services/downloader');
const config = require('../config');
const { generateId } = require('../utils/helpers');

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
    ],
  });
});

/** Parse video info. */
router.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供视频链接', field: 'url' });
  }

  // For platforms that may need the browser extension bridge,
  // try direct parsing first (yt-dlp / doubao API), then fall back to bridge
  const isXiaohongshu = url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn');
  const needsBridge = url.includes('douyin.com') || url.includes('kuaishou.com')
    || isXiaohongshu || url.includes('doubao.com');

  if (needsBridge) {
    const platform = url.includes('doubao.com') ? '豆包'
      : url.includes('xiaohongshu.com') || url.includes('xhslink.com') ? '小红书'
      : url.includes('kuaishou.com') || url.includes('gifshow.com') ? '快手'
      : '抖音';
    try {
      let info;
      if (url.includes('doubao.com')) {
        // For Doubao, use the dedicated Doubao API
        const videoId = extractVideoId(url);
        if (!videoId) throw new Error('无法从链接中提取 video_id');
        info = await getPlayInfo(videoId);
      } else {
        // For other bridge platforms, use yt-dlp
        info = await getVideoInfo(url);
      }
      return res.json({
        success: true,
        data: {
          title: info.title,
          author: info.author,
          duration: info.duration,
          durationFormatted: formatDuration(info.duration),
          thumbnailUrl: info.thumbnailUrl,
          platform: info.platformLabel || platform,
          videoId: info.videoId,
          webpageUrl: info.webpageUrl,
          directUrl: info.directUrl,
          hasOriginal: info.hasOriginal,
        },
      });
    } catch (err) {
      console.log(`[info] ${platform} direct parsing failed: ${err.message}, falling back to bridge`);
      return res.json({
        success: true,
        data: {
          title: '正在解析中...',
          author: '',
          duration: 0,
          durationFormatted: '0:00',
          thumbnailUrl: null,
          platform: platform,
          videoId: '',
          webpageUrl: url,
          directUrl: null,
          hasOriginal: false,
          bridgeTip: '正在通过浏览器解析，请稍候...',
        },
      });
    }
  }

  try {
    const info = await getVideoInfo(url);
    res.json({
      success: true,
      data: {
        title: info.title,
        author: info.author,
        duration: info.duration,
        durationFormatted: formatDuration(info.duration),
        thumbnailUrl: info.thumbnailUrl,
        platform: info.platformLabel,
        videoId: info.videoId,
        webpageUrl: info.webpageUrl,
        directUrl: info.directUrl,
        hasOriginal: info.hasOriginal,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Format duration in mm:ss. */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Create download task. */
router.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供视频链接', field: 'url' });
  }

  // Bridge-requiring platforms - try direct parsing first
  const isXiaohongshu = url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn');
  const needsBridge = url.includes('douyin.com') || url.includes('kuaishou.com')
    || isXiaohongshu || url.includes('doubao.com');

  if (needsBridge) {
    try {
      let info;
      const platformLabel = url.includes('doubao.com') ? '豆包'
        : url.includes('xiaohongshu.com') || url.includes('xhslink.com') ? '小红书'
        : url.includes('kuaishou.com') ? '快手'
        : '抖音';

      if (url.includes('doubao.com')) {
        // For Doubao, use the dedicated Doubao API
        const videoId = extractVideoId(url);
        if (!videoId) throw new Error('无法从链接中提取 video_id');
        info = await getPlayInfo(videoId);
      } else {
        // For other bridge platforms, use yt-dlp
        info = await getVideoInfo(url);
      }

      // If yt-dlp got metadata but no direct URL (common for Xiaohongshu),
      // fall back to bridge queue for actual download
      if (!info.directUrl && (
        url.includes('xiaohongshu.com') || url.includes('xhslink.com') ||
        url.includes('kuaishou.com')
      )) {
        console.log(`[bridge] ${platformLabel} has no direct URL, falling back to bridge`);
        throw new Error('无直接下载地址，需要浏览器辅助');
      }

      const task = createTask(url, {
        title: info.title,
        platform: info.platformLabel || platformLabel,
        directUrl: info.directUrl || null,
      });
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
      // Fall back to bridge queue
      const taskId = `bridge_${++taskIdCounter}_${Date.now()}`;
      const platformLabel = url.includes('doubao.com') ? '豆包'
        : url.includes('xiaohongshu.com') || url.includes('xhslink.com') ? '小红书'
        : url.includes('kuaishou.com') ? '快手'
        : '抖音';
      parseQueue.push({
        taskId, url, status: 'pending',
        result: null, createdAt: Date.now()
      });
      console.log(`[bridge] Download queued for ${platformLabel}: ${url.slice(0, 60)}...`);
      return res.json({
        success: true,
        data: {
          id: taskId,
          title: '等待浏览器处理...',
          platform: platformLabel,
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
    });

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
    const bridgeTask = parseQueue.find(t => t.taskId === taskId);
    if (bridgeTask) {
      const platform = bridgeTask.url.includes('doubao.com') ? '豆包'
        : bridgeTask.url.includes('xiaohongshu.com') || bridgeTask.url.includes('xhslink.com') ? '小红书'
        : bridgeTask.url.includes('kuaishou.com') || bridgeTask.url.includes('gifshow.com') ? '快手'
        : '抖音';

      // Bridge task timeout: 5 minutes
      const BRIDGE_TASK_TIMEOUT = 300000;
      if (bridgeTask.status !== 'completed' && bridgeTask.status !== 'failed' && Date.now() - bridgeTask.createdAt > BRIDGE_TASK_TIMEOUT) {
        bridgeTask.status = 'failed';
        bridgeTask.error = '桥接解析超时，请确保浏览器扩展（桥接扩展）已安装并运行';
      }

      return res.json({
        id: bridgeTask.taskId,
        status: bridgeTask.status === 'completed' ? 'completed' : bridgeTask.status === 'failed' ? 'failed' : 'downloading',
        progress: bridgeTask.status === 'completed' ? 100 : 0,
        title: '等待浏览器处理...',
        platform: platform,
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
router.get('/file/:id', (req, res) => {
  const filePath = getTaskFile(req.params.id);
  if (!filePath) {
    return res.status(404).json({ error: '视频文件不存在或未完成' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件已过期' });
  }
  res.sendFile(filePath);
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
const parseQueue = [];
let taskIdCounter = 0;

/** Submit a URL for the browser extension to parse */
router.post('/bridge/parse', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: '请提供视频链接' });
  }

  const taskId = `bridge_${++taskIdCounter}_${Date.now()}`;
  parseQueue.push({ taskId, url, status: 'pending', result: null, createdAt: Date.now() });

  console.log(`[bridge] Queued parse task: ${taskId} for ${url.slice(0, 60)}...`);
  res.json({ success: true, taskId });
});

/** Extension polls for pending tasks */
router.get('/bridge/tasks', (req, res) => {
  // Clean up stale tasks older than 5 minutes
  const now = Date.now();
  for (let i = parseQueue.length - 1; i >= 0; i--) {
    if (now - parseQueue[i].createdAt > 300000) {
      parseQueue.splice(i, 1);
    }
  }

  // Return the most recent pending task and mark it as processing
  const pending = parseQueue.filter(t => t.status === 'pending');
  if (pending.length > 0) {
    // Sort by creation time (newest first)
    pending.sort((a, b) => b.createdAt - a.createdAt);
    const task = pending[0];
    task.status = 'processing';
    return res.json({ hasTask: true, taskId: task.taskId, url: task.url });
  }
  res.json({ hasTask: false });
});

/** Extension reports result back */
router.post('/bridge/result', (req, res) => {
  const { taskId, videoUrl, error } = req.body;
  const task = parseQueue.find(t => t.taskId === taskId);
  if (task) {
    task.status = videoUrl ? 'completed' : 'failed';
    task.result = videoUrl || null;
    task.error = error || null;
    task.completedAt = Date.now();
    console.log(`[bridge] Task ${taskId} completed: ${videoUrl ? 'OK' : 'FAILED'}`);
  }
  res.json({ success: true });
});

/** Mini program checks task status */
router.get('/bridge/status/:taskId', (req, res) => {
  const task = parseQueue.find(t => t.taskId === req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json({
    taskId: task.taskId,
    status: task.status,
    videoUrl: task.result,
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

module.exports = router;