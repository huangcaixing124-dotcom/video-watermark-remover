/**
 * Playwright 浏览器服务 — 持久化无头浏览器，替代桥接扩展。
 *
 * 功能：
 * - 启动一个持久化的 Chromium 浏览器实例
 * - 通过 page.route() 拦截网络请求，提取视频 URL
 * - 支持快手、抖音、豆包等平台
 *
 * 用法：
 *   const { extractVideo } = require('./playwrightService');
 *   const result = await extractVideo('https://v.kuaishou.com/xxx');
 *   // => { videoUrl: '...', title: '...', ... }
 */
const path = require('path');
const config = require('../config');

let _browser = null;
let _launching = null;

/**
 * 获取或启动浏览器实例（单例，延迟初始化）。
 */
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    try {
      const { chromium } = require('playwright');
      const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
      const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
      const fs = require('fs');
      const executablePath = fs.existsSync(chromePath) ? chromePath
        : fs.existsSync(edgePath) ? edgePath
        : undefined;

      _browser = await chromium.launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });
      console.log('[playwright] Browser started');
      _browser.on('disconnected', () => {
        console.log('[playwright] Browser disconnected');
        _browser = null;
      });
      return _browser;
    } finally {
      _launching = null;
    }
  })();
  return _launching;
}

/**
 * 关闭浏览器。
 */
async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

/**
 * 提取视频 URL — 主入口。
 * @param {string} url - 视频页面 URL
 * @param {object} options - { timeout: 30000 }
 * @returns {Promise<{videoUrl: string, title: string, platform: string}>}
 */
async function extractVideo(url, options = {}) {
  const timeout = options.timeout || 45000;
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  // 加载 cookies（如果有）
  try {
    const cookiesFile = path.join(config.projectDir, 'cookies.txt');
    const fs = require('fs');
    if (fs.existsSync(cookiesFile)) {
      const content = fs.readFileSync(cookiesFile, 'utf-8');
      const cookies = [];
      for (const line of content.split('\n')) {
        const parts = line.trim().split('\t');
        if (parts.length >= 7 && !line.startsWith('#')) {
          cookies.push({
            name: parts[5], value: parts[6], domain: parts[0].replace(/^\./, ''),
            path: parts[2], secure: parts[3] === 'TRUE',
          });
        }
      }
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`[playwright] Loaded ${cookies.length} cookies`);
      }
    }
  } catch {}

  const page = await context.newPage();
  let result = null;
  let timeoutHandle = null;

  try {
    // 根据平台设置不同的拦截策略
    if (url.includes('kuaishou.com') || url.includes('gifshow.com')) {
      result = await extractKuaishou(page, url, timeout);
    } else if (url.includes('doubao.com')) {
      result = await extractDoubao(page, url, timeout);
    } else if (url.includes('douyin.com') || url.includes('iesdouyin.com')) {
      result = await extractDouyin(page, url, timeout);
    } else if (url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn')) {
      result = await extractXiaohongshu(page, url, timeout);
    } else {
      throw new Error('不支持的平台');
    }

    if (!result || !result.videoUrl) {
      throw new Error('未能提取到视频 URL');
    }
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/** 解码快手视频 URL 中的 Unicode 转义（\\u002F → /, \\u0026 → &）*/
function decodeVideoUrl(url) {
  if (!url) return '';
  return url
    .replace(/\\u0025/g, '%')
    .replace(/\\u003d/g, '=')
    .replace(/\\u003f/g, '?')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\u002f/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '');
}

/**
 * 快手提取 — 监听 API 响应，提取视频 URL。
 */
async function extractKuaishou(page, url, timeout) {
  let videoUrl = null;
  let videoTitle = '快手视频';
  let responseCount = 0;

  // 从页面 URL 中提取视频 ID（用于验证找到的 URL 是否匹配当前页面）
  const pageVideoId = url.match(/\/([a-zA-Z0-9]+)$/)?.[1] || '';

  // 被动监听所有响应，不拦截请求
  page.on('response', async (response) => {
    if (videoUrl) return; // 已找到，不再处理
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json') && !ct.includes('text')) return;
      responseCount++;
      const body = await response.text();
      if (!body || body.length < 50) return;

      // 1. 优先匹配 photoUrl（快手主视频 URL 字段）
      const photoMatch = body.match(/photoUrl["']?\s*[:=]\s*["']([^"']+)["']/);
      if (photoMatch) {
        const found = decodeVideoUrl(photoMatch[1]);
        if (found.includes('mp4') || found.includes('djvod') || found.includes('kwimgs')) {
          videoUrl = found;
          console.log(`[playwright] Kuaishou photoUrl: ${videoUrl.substring(0, 100)}`);
        }
      }

      // 2. 如果没找到 photoUrl，尝试其他视频 URL 模式
      if (!videoUrl) {
        const urlPatterns = [
          /"mainUrl"\s*:\s*"([^"]+)"/,
          /"playUrl"\s*:\s*"([^"]+)"/,
          /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/,
        ];
        for (const p of urlPatterns) {
          const m = body.match(p);
          if (m) {
            const found = decodeVideoUrl(m[1]);
            if (found.includes('mp4') || found.includes('djvod')) {
              videoUrl = found;
              console.log(`[playwright] Kuaishou URL found: ${videoUrl.substring(0, 100)}`);
              break;
            }
          }
        }
      }

      // 3. 提取标题
      if (!videoTitle || videoTitle === '快手视频') {
        const tm = body.match(/"caption"\s*:\s*"([^"]+)"/);
        if (tm) videoTitle = tm[1].slice(0, 100);
      }
    } catch {}
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {
    console.log('[playwright] Kuaishou page load timeout, continuing with loaded data');
  });
  // 等待 API 响应回来
  await page.waitForTimeout(3000);
  console.log(`[playwright] Kuaishou page loaded, ${responseCount} responses checked`);

  // 如果还没找到，尝试从页面 DOM 提取
  if (!videoUrl) {
    const domUrl = await page.evaluate(() => {
      // 查找 video 元素
      const v = document.querySelector('video');
      if (v && v.src) return v.src;
      // 查找 source 元素
      const s = document.querySelector('video source');
      if (s && s.src) return s.src;
      // 查找所有带视频 URL 的脚本标签
      const scripts = document.querySelectorAll('script');
      for (const sc of scripts) {
        const text = sc.textContent || '';
        const m = text.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
        if (m) return m[0];
      }
      return null;
    }).catch(() => null);
    if (domUrl) videoUrl = decodeVideoUrl(domUrl);
  }

  return { videoUrl, title: videoTitle, platform: '快手' };
}

/**
 * 豆包提取 — 拦截 get_play_info / get_download_info API。
 */
async function extractDoubao(page, url, timeout) {
  let videoUrl = null;
  let videoTitle = '豆包视频';

  // 拦截 samantha API
  await page.route('**/samantha/**', async (route) => {
    const response = await route.fetch();
    try {
      const body = await response.text();
      // 尝试所有可能的视频 URL 字段
      const patterns = [
        /"main_url"\s*:\s*"([^"]+)"/,
        /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/,
        /"play_url"\s*:\s*"([^"]+)"/,
        /"download_url"\s*:\s*"([^"]+)"/,
        /https?:\/\/[^"'\s]+\.mp4[^"'\s]*/,
      ];
      for (const p of patterns) {
        const m = body.match(p);
        if (m) {
          videoUrl = m[1] || m[0];
          // 处理 Unicode 转义
          videoUrl = videoUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
          console.log(`[playwright] Doubao URL found: ${videoUrl.substring(0, 80)}`);
          break;
        }
      }
      const titleMatch = body.match(/"title"\s*:\s*"([^"]+)"/);
      if (titleMatch) videoTitle = titleMatch[1];
    } catch {}
    route.fulfill({ response });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForTimeout(5000);

  return { videoUrl, title: videoTitle, platform: '豆包' };
}

/**
 * 抖音提取 — 拦截视频 API 响应。
 */
async function extractDouyin(page, url, timeout) {
  let videoUrl = null;
  let videoTitle = '抖音视频';

  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    if (!videoUrl) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await response.text();
          // 抖音视频 URL 模式
          const m = body.match(/https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*/);
          if (m) videoUrl = m[0];
        }
      } catch {}
    }
    route.fulfill({ response });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForTimeout(5000);

  return { videoUrl, title: videoTitle, platform: '抖音' };
}

/**
 * 小红书提取 — 拦截 API 响应获取笔记数据（支持视频和图文）。
 */
async function extractXiaohongshu(page, url, timeout) {
  let videoUrl = null;
  let videoTitle = '小红书笔记';
  let author = '';
  let description = '';

  // 拦截所有请求，从 API 响应中提取笔记数据
  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    if (!videoUrl) {
      try {
        const ct = response.headers()['content-type'] || '';
        // 关注 JSON 响应和 JavaScript 响应（可能包含内嵌数据）
        if (ct.includes('json') || ct.includes('javascript')) {
          const body = await response.text();
          if (body && body.length > 100) {
            // 提取视频 URL
            const vMatch = body.match(/https?:\/\/[^"'\s,]+\.(?:mp4|m3u8)[^"'\s,]*/);
            if (vMatch) videoUrl = vMatch[0];

            // 提取标题/描述
            const descMatch = body.match(/"display_title"\s*:\s*"([^"]+)"/);
            if (descMatch && !description) description = descMatch[1];
            if (!description) {
              const dMatch = body.match(/"desc"\s*:\s*"([^"]+)"/);
              if (dMatch) description = dMatch[1];
            }

            // 提取作者
            const aMatch = body.match(/"nickname"\s*:\s*"([^"]+)"/);
            if (aMatch && !author) author = aMatch[1];
          }
        }
      } catch {}
    }
    route.fulfill({ response });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForTimeout(5000);

  // 如果还没找到视频 URL，尝试从 DOM 提取
  if (!videoUrl) {
    videoUrl = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && v.src) return v.src;
      const s = document.querySelector('video source');
      if (s && s.src) return s.src;
      return null;
    }).catch(() => null);
  }

  return { videoUrl, title: videoTitle, author, platform: '小红书' };
}

module.exports = { extractVideo, closeBrowser, getBrowser };