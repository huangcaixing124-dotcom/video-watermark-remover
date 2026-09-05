/**
 * Video Watermark Remover + Transcript Extractor — Express server entry point.
 */
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const config = require('./config');

// ── Express App ─────────────────────────────────────────────────
const app = express();

app.use(cors());
// 请求日志默认关闭（不输出 morgan 行）。
app.use(morgan('combined', { skip: () => true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Routes ──────────────────────────────────────────────────────
const videoRoutes = require('./routes/video');
const transcriptRoutes = require('./routes/transcript');
const zenSleepRoutes = require('./routes/zen-sleep');

app.use('/api/video', videoRoutes);
app.use('/api/transcript', transcriptRoutes);
app.use('/api/zen-sleep', zenSleepRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Platforms list
app.get('/api/platforms', (_req, res) => {
  res.json({
    platforms: [
      { name: 'douyin', label: '抖音' },
      { name: 'tiktok', label: 'TikTok' },
      { name: 'kuaishou', label: '快手' },
      { name: 'bilibili', label: 'B站' },
      { name: 'weibo', label: '微博' },
      { name: 'xiaohongshu', label: '小红书' },
      { name: 'youtube', label: 'YouTube' },
      { name: 'instagram', label: 'Instagram' },
      { name: 'twitter', label: 'Twitter/X' },
      { name: 'doubao', label: '豆包' },
      { name: 'jimeng', label: '即梦' },
      { name: 'other', label: '其他平台' },
    ],
  });
});

// ── Serve static files from cache ──────────────────────────────
// 移除 /cache 静态文件暴露 — 由 /api/video/file/:id 路由控制访问
// app.use('/cache', express.static(config.cacheDir));

// ── Error handler ───────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Auto-create cache dir ──────────────────────────────────────
if (!fs.existsSync(config.cacheDir)) {
  fs.mkdirSync(config.cacheDir, { recursive: true });
}

// ── Global error handlers ───────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // 记录日志后不退出进程，让 PM2 决定是否重启
});

// ── Graceful shutdown ──────────────────────────────────────────
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${signal}] 正在关闭服务器...`);
  // 关闭 Playwright 浏览器
  try {
    const { closeBrowser } = require('./services/playwrightService');
    closeBrowser().catch(() => {});
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ── Start (only when run directly, not when imported as module) ──
if (require.main === module) {
  const server = app.listen(config.port, config.host, () => {
    console.log(`\n${'='.repeat(52)}`);
    console.log(`  去水印视频工具 服务已启动`);
    console.log(`  端口: ${config.port}`);
    console.log(`  地址: http://${config.host}:${config.port}`);
    console.log(`  缓存目录: ${config.cacheDir}`);
    console.log(`  Whisper模型: ${config.whisperModelSize}`);
    console.log(`  设备: ${config.whisperDevice}`);
    console.log(`${'='.repeat(52)}\n`);
  });
}

module.exports = app;