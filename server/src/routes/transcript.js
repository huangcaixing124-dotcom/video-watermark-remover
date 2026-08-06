/**
 * Transcript API routes.
 *
 * - POST /api/transcript/start  - Create transcription task
 * - GET  /api/transcript/task/:id  - Get task status + text
 * - GET  /api/transcript/text/:id  - Get raw text only
 * - GET  /api/transcript/srt/:id  - Get SRT file
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const { createTask, getTask, getTranscriptText, getSrtPath, startCleanup } = require('../services/transcriber');
const { getVideoInfo } = require('../services/ytdlp');
const { detectPlatform, formatDuration } = require('../utils/helpers');
const config = require('../config');

/** Max duration in seconds for transcription (10 minutes). */
const MAX_DURATION_SECONDS = 600;

/** Start a transcription task. */
router.post('/start', async (req, res) => {
  const { url, language = 'zh' } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '请提供视频链接', field: 'url' });
  }

  // 先解析视频信息，检查时长
  try {
    const { needsBridge } = detectPlatform(url);
    let duration = 0;

    if (!needsBridge) {
      // 对于不需要桥接的平台，直接用 yt-dlp 获取时长
      try {
        const info = await getVideoInfo(url);
        if (info && info.duration) {
          duration = info.duration;
        }
      } catch (infoErr) {
        // 解析失败不阻止转录，让转录流程自己处理
        console.log(`[transcript] Info check failed, proceeding: ${infoErr.message}`);
      }
    } else {
      // 需要桥接的平台，时长可能无法获取，跳过检查
      console.log(`[transcript] Bridge platform, skipping duration check`);
    }

    if (duration > MAX_DURATION_SECONDS) {
      return res.json({
        success: false,
        error: `视频时长 ${formatDuration(duration)}，超过10分钟限制。当前工具仅支持10分钟以内的视频文案提取。`,
        tooLong: true,
        duration: duration,
        durationFormatted: formatDuration(duration),
      });
    }
  } catch (err) {
    // 如果解析失败，不阻止转录
    console.log(`[transcript] Duration check error, proceeding: ${err.message}`);
  }

  try {
    const task = createTask(url, { language });
    res.json({
      success: true,
      data: {
        id: task.id,
        status: task.status,
        progress: task.progress,
        message: '文案提取任务已创建，正在处理中...',
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Get transcription task status and result. */
router.get('/task/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }
  res.json(task);
});

/** Get raw transcript text. */
router.get('/text/:id', (req, res) => {
  const text = getTranscriptText(req.params.id);
  if (!text) {
    return res.status(404).json({ error: '文案不存在或未提取完成' });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(text);
});

/** Get SRT subtitle file. */
router.get('/srt/:id', (req, res) => {
  const srtPath = getSrtPath(req.params.id);
  if (!srtPath || !fs.existsSync(srtPath)) {
    return res.status(404).json({ error: 'SRT文件不存在或未生成' });
  }
  res.setHeader('Content-Type', 'text/srt; charset=utf-8');
  res.sendFile(srtPath);
});

// Start cleanup timer
startCleanup();

module.exports = router;