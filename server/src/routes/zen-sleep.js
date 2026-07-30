/**
 * zen-sleep-mp 音频服务
 * 提供：静态音频托管 + 混合音频实时合成 + 外部 URL 代理缓存
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

// ── 配置 ──────────────────────────────────────────────────────────
const SERVER_DIR = __dirname;
const ZEN_CACHE_DIR = path.resolve(SERVER_DIR, '..', '.zen-cache');
const AUDIO_SRC_DIR = path.resolve(SERVER_DIR, '..', '..', '..', 'zen-sleep-mp', 'assets');

// 呼吸模式定义
const PATTERNS = {
  '478':  { phases: [{n:'inhale',d:4},{n:'hold',d:7},{n:'exhale',d:8}], rest: 2 },
  'box':  { phases: [{n:'inhale',d:4},{n:'hold',d:4},{n:'exhale',d:4},{n:'hold',d:4}], rest: 0 },
  'calm': { phases: [{n:'inhale',d:4},{n:'exhale',d:6}], rest: 0 },
};

// 环境音种类
const AMBIENT_TYPES = ['rain','ocean','stream','fire','downpour','wind'];

// 默认混合时长（秒）
const MIX_DURATION = 900; // 15 分钟

// ── 确保缓存目录 ──────────────────────────────────────────────────
if (!fs.existsSync(ZEN_CACHE_DIR)) {
  fs.mkdirSync(ZEN_CACHE_DIR, { recursive: true });
}

// ── 工具函数 ──────────────────────────────────────────────────────

/** 获取音频源文件路径 */
function getSrcPath(subdir, filename) {
  const p = path.join(AUDIO_SRC_DIR, subdir, filename);
  if (fs.existsSync(p)) return p;
  // 尝试桌面打包目录
  const desktop = path.join('C:\\Users\\Administrator\\Desktop\\zen-sleep-mp\\assets', subdir, filename);
  if (fs.existsSync(desktop)) return desktop;
  // 尝试原项目目录
  const original = path.join('F:\\zen-sleep-mp\\assets', subdir, filename);
  if (fs.existsSync(original)) return original;
  return null;
}

/** 获取环境音高音质文件路径 */
function getAmbientSrc(type) {
  return getSrcPath('audio-hq', type + '.mp3') || getSrcPath('audio', 'ambient_' + type + '.mp3');
}

/** 获取短音文件路径 */
function getShortSrc(name) {
  return getSrcPath('audio', name + '.mp3');
}

/** 计算呼吸周期总时长 */
function getCycleDuration(pattern) {
  const p = PATTERNS[pattern];
  if (!p) return 0;
  return p.phases.reduce((sum, ph) => sum + ph.d, 0) + (p.rest || 0);
}

/** 获取每个阶段在周期内的起始时间 */
function getPhaseOffsets(pattern) {
  const p = PATTERNS[pattern];
  if (!p) return [];
  const offsets = [];
  let offset = 0;
  for (const ph of p.phases) {
    if (ph.n === 'inhale' || ph.n === 'exhale') {
      offsets.push({ name: ph.n, offset });
    }
    offset += ph.d;
  }
  return offsets;
}

// ── 静态文件服务 ──────────────────────────────────────────────────

// 托管环境音（高音质版）
router.get('/audio/:type', (req, res) => {
  const type = req.params.type;
  if (!AMBIENT_TYPES.includes(type)) {
    return res.status(404).json({ error: '未知的环境音类型' });
  }
  const filePath = getAmbientSrc(type);
  if (!filePath) {
    return res.status(404).json({ error: '音频文件不存在' });
  }
  res.sendFile(filePath);
});

// 托管短音
router.get('/audio-short/:name', (req, res) => {
  const name = req.params.name;
  const valid = ['muyu', 'bowl', 'inhale', 'exhale'];
  if (!valid.includes(name)) {
    return res.status(404).json({ error: '未知的短音类型' });
  }
  const filePath = getShortSrc(name);
  if (!filePath) {
    return res.status(404).json({ error: '音频文件不存在' });
  }
  res.sendFile(filePath);
});

// ── 混合音频实时合成 ──────────────────────────────────────────────

router.get('/mix/:type/:pattern', (req, res) => {
  const type = req.params.type;
  const pattern = req.params.pattern;
  const duration = parseInt(req.query.d || MIX_DURATION, 10);

  if (!AMBIENT_TYPES.includes(type)) {
    return res.status(404).json({ error: '未知的环境音类型' });
  }
  if (!PATTERNS[pattern]) {
    return res.status(404).json({ error: '未知的呼吸模式' });
  }

  // 缓存文件名
  const cacheKey = `mix_${type}_${pattern}_${duration}.mp3`;
  const cachePath = path.join(ZEN_CACHE_DIR, cacheKey);

  // 缓存命中直接返回
  if (fs.existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  const ambientFile = getAmbientSrc(type);
  const inhaleFile = getShortSrc('inhale');
  const exhaleFile = getShortSrc('exhale');

  if (!ambientFile || !inhaleFile || !exhaleFile) {
    return res.status(500).json({ error: '源音频文件缺失' });
  }

  const cycleDur = getCycleDuration(pattern);
  const cycles = Math.ceil(duration / cycleDur);
  const offsets = getPhaseOffsets(pattern);

  // 构建 FFmpeg 命令
  // 策略：使用 aloop(size=0) 循环整个音源，用 atrim 限制总时长
  const filters = [];

  // 环境音循环（size=0 表示循环整个输入文件）
  filters.push(`[0:a]aloop=loop=${cycles - 1}:size=0,atrim=0:${duration}[amb]`);

  // 为每个周期的每个导引音创建 adelay
  const adelayInputs = [];
  for (let c = 0; c < cycles; c++) {
    for (const ph of offsets) {
      const delayMs = (c * cycleDur + ph.offset) * 1000;
      const srcIdx = ph.name === 'inhale' ? 1 : 2;
      adelayInputs.push(`[${srcIdx}:a]adelay=${delayMs}|${delayMs}[d${c}_${ph.name}]`);
    }
  }

  // 追踪 adelay 输出标签
  const adelayLabels = [];
  for (let c = 0; c < cycles; c++) {
    for (const ph of offsets) {
      adelayLabels.push(`[d${c}_${ph.name}]`);
    }
  }

  const allFilters = filters.concat(adelayInputs);
  const mixLabel = '[final]';
  const mixInputStr = ['[amb]'].concat(adelayLabels).join('');
  allFilters.push(`${mixInputStr}amix=inputs=${1 + adelayLabels.length}:duration=first${mixLabel}`);

  // 构建 FFmpeg 参数
  const args = [
    '-i', ambientFile,
    '-i', inhaleFile,
    '-i', exhaleFile,
    '-filter_complex', allFilters.join(';'),
    '-map', '[final]',
    '-t', String(duration),
    '-ac', '1',
    '-ar', '44100',
    '-b:a', '128k',
    '-y', cachePath,
  ];

  console.log(`[zen-sleep] 合成混合音频: ${type}/${pattern} (${duration}s)`);
  console.log(`[zen-sleep] FFmpeg 命令: ${FFMPEG_PATH} ${args.slice(0, 3).join(' ')} ...`);

  const ffmpeg = spawn(FFMPEG_PATH, args);

  ffmpeg.on('error', (err) => {
    console.error('[zen-sleep] FFmpeg 启动失败:', err.message);
    // 降级：直接返回环境音
    res.sendFile(ambientFile);
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      console.error(`[zen-sleep] FFmpeg 退出码: ${code}`);
      // 降级：直接返回环境音
      if (!res.headersSent) return res.sendFile(ambientFile);
      return;
    }
    console.log(`[zen-sleep] 合成完成: ${cacheKey}`);
    if (!res.headersSent) res.sendFile(cachePath);
  });

  // 指定超时
  const timeout = setTimeout(() => {
    ffmpeg.kill();
    if (!res.headersSent) {
      res.status(504).json({ error: '合成超时，降级使用环境音' });
      res.sendFile(ambientFile);
    }
  }, 120000); // 2 分钟超时

  ffmpeg.on('close', () => clearTimeout(timeout));
});

// ── 外部 URL 代理缓存 ────────────────────────────────────────────

/** 递归下载（支持重定向跟踪） */
function downloadWithRedirect(url, cachePath, res, redirectCount) {
  if (redirectCount > 5) {
    if (res) return res.redirect(url);
    return;
  }
  const http = require('http');
  const https = require('https');
  const transporter = url.startsWith('https') ? https : http;

  transporter.get(url, (response) => {
    // 处理重定向
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      const redirectUrl = new URL(response.headers.location, url).href;
      return downloadWithRedirect(redirectUrl, cachePath, res, redirectCount + 1);
    }

    if (response.statusCode !== 200) {
      if (res) return res.redirect(url);
      return;
    }

    const fileStream = fs.createWriteStream(cachePath);
    response.pipe(fileStream);

    fileStream.on('finish', () => {
      fileStream.close();
      if (res) res.sendFile(cachePath);
    });

    fileStream.on('error', () => {
      if (res) res.redirect(url);
    });
  }).on('error', () => {
    if (res) res.redirect(url);
  });
}

router.get('/proxy', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });

  // 生成缓存文件名
  const ext = path.extname(new URL(url).pathname) || '.mp3';
  const hash = require('crypto').createHash('md5').update(url).digest('hex');
  const cachePath = path.join(ZEN_CACHE_DIR, 'proxy_' + hash + ext);

  // 缓存命中
  if (fs.existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  console.log(`[zen-sleep] 代理下载: ${url}`);
  downloadWithRedirect(url, cachePath, res, 0);
});

// ── 可用资源列表 ──────────────────────────────────────────────────

router.get('/info', (_req, res) => {
  res.json({
    ambientTypes: AMBIENT_TYPES,
    patterns: Object.keys(PATTERNS),
    shortSounds: ['muyu', 'bowl', 'inhale', 'exhale'],
    mixDuration: MIX_DURATION,
    cacheDir: ZEN_CACHE_DIR,
  });
});

module.exports = router;