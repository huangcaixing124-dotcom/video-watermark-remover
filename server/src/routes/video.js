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
const router = express.Router();

const { getVideoInfo, downloadVideo } = require('../services/ytdlp');
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

  try {
    // First get video info to populate task metadata
    const info = await getVideoInfo(url);

    const task = createTask(url);
    task.title = info.title;
    task.platform = info.platformLabel;

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
  const task = getTask(req.params.id);
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

    const result = await downloadVideo(url, outputDir);

    // Serve the file
    res.sendFile(result.filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start cleanup timer when routes are loaded
startCleanup();

module.exports = router;