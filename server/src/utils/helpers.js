/**
 * Helper utilities.
 */
const crypto = require('crypto');

/** Generate a short unique ID with server prefix for Worker routing. */
function generateId() {
  const serverId = process.env.SERVER_ID || '0';
  return serverId + crypto.randomBytes(6).toString('hex');
}

/** Format duration from seconds to mm:ss. */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Sanitize filename (remove dangerous chars). */
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 200);
}

/** Estimate file size in MB from content-length bytes. */
function estimateSizeMB(bytes) {
  if (!bytes) return null;
  return Math.round((parseInt(bytes, 10) / 1024 / 1024) * 100) / 100;
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect platform from a URL.
 * Returns { platform, label, needsBridge }.
 */
function detectPlatform(url) {
  if (!url) return { platform: 'unknown', label: '未知', needsBridge: false };
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return { platform: 'douyin', label: '抖音', needsBridge: true };
  if (url.includes('kuaishou.com') || url.includes('gifshow.com')) return { platform: 'kuaishou', label: '快手', needsBridge: true };
  if (url.includes('doubao.com')) return { platform: 'doubao', label: '豆包', needsBridge: true };
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn')) return { platform: 'xiaohongshu', label: '小红书', needsBridge: true };
  if (url.includes('bilibili.com')) return { platform: 'bilibili', label: 'B站', needsBridge: false };
  if (url.includes('youtube.com') || url.includes('youtu.be')) return { platform: 'youtube', label: 'YouTube', needsBridge: false };
  if (url.includes('tiktok.com')) return { platform: 'tiktok', label: 'TikTok', needsBridge: false };
  if (url.includes('weibo.com') || url.includes('weibo.cn')) return { platform: 'weibo', label: '微博', needsBridge: true };
  if (url.includes('jimeng') || url.includes('jimeng.com')) return { platform: 'jimeng', label: '即梦', needsBridge: false };
  return { platform: 'other', label: '其他', needsBridge: false };
}

/**
 * Get the correct Referer header for a given URL.
 */
function getRefererForUrl(url) {
  if (url.includes('bilibili.com')) return 'https://www.bilibili.com/';
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn')) return 'https://www.xiaohongshu.com/';
  if (url.includes('kuaishou.com') || url.includes('gifshow.com')) return 'https://www.kuaishou.com/';
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return 'https://www.douyin.com/';
  if (url.includes('doubao.com')) return 'https://www.doubao.com/';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'https://www.youtube.com/';
  if (url.includes('tiktok.com')) return 'https://www.tiktok.com/';
  if (url.includes('weibo.com') || url.includes('weibo.cn')) return 'https://www.weibo.com/';
  return 'https://www.douyin.com/';
}

/**
 * 从 URL 归一化出平台 key（与 PLATFORMS cookie 文件名一致）。
 * 供 resolveCookiesFile 及各服务按平台分发 cookie。
 */
function platformFromUrl(url) {
  if (!url) return 'other';
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return 'douyin';
  if (url.includes('kuaishou.com') || url.includes('gifshow.com')) return 'kuaishou';
  if (url.includes('doubao.com')) return 'doubao';
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn')) return 'xiaohongshu';
  if (url.includes('bilibili.com') || url.includes('b23.tv')) return 'bilibili';
  if (url.includes('weibo.com') || url.includes('weibo.cn')) return 'weibo';
  return 'other';
}

/**
 * 返回某个 URL 应使用的 cookie 文件绝对路径（多平台独立 cookie 方案）。
 * 规则：优先 server/config/<platform>_cookies.txt（如 douyin_cookies.txt）；
 *       该平台无独立文件时回退到旧的共享 cookies.txt（若存在）。
 * 返回 null 表示两者皆无。
 */
function resolveCookiesFile(url) {
  const fs = require('fs');
  const path = require('path');
  const config = require('../config');
  const plat = platformFromUrl(url);
  // 独立平台 cookie 文件位于 <项目根>/server/config/（与 cookie_splitter.js 输出一致）
  const configDir = path.join(config.projectDir, 'server', 'config');
  if (plat !== 'other' && plat !== 'youtube' && plat !== 'tiktok') {
    const platformFile = path.join(configDir, `${plat}_cookies.txt`);
    if (fs.existsSync(platformFile)) return platformFile;
  }
  // 回退：旧的共享 cookies.txt
  for (const p of [path.join(config.projectDir, 'cookies.txt'), path.join(config.serverDir, '..', 'cookies.txt')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { generateId, formatDuration, sanitizeFilename, estimateSizeMB, sleep, detectPlatform, getRefererForUrl, platformFromUrl, resolveCookiesFile };