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

module.exports = { generateId, formatDuration, sanitizeFilename, estimateSizeMB, sleep, detectPlatform, getRefererForUrl };