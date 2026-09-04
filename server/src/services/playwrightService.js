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
const { resolveCookiesFile } = require('../utils/helpers');

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

  // 加载 cookies（按平台独立文件，回退共享 cookies.txt）
  try {
    const cookiesFile = resolveCookiesFile(url);
    const fs = require('fs');
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      const content = fs.readFileSync(cookiesFile, 'utf-8');
      const cookies = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const raw = line.trim();
        const parts = raw.split('\t');
        // Netscape: domain, includeSub, path, secure, expiry, name, value
        if (parts.length < 7) continue;
        // HttpOnly 行以 "#HttpOnly_" 开头（是真实 cookie，非注释），domain 去掉前缀
        const isHttpOnly = raw.startsWith('#HttpOnly_');
        if (raw.startsWith('#') && !isHttpOnly) continue; // 普通注释跳过
        let domain = parts[0];
        if (isHttpOnly) domain = domain.replace(/^#HttpOnly_/, '');
        cookies.push({
          name: parts[5], value: parts[6], domain: domain.replace(/^\./, ''),
          path: parts[2], secure: parts[3] === 'TRUE',
          httpOnly: isHttpOnly,
        });
      }
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`[playwright] Loaded ${cookies.length} cookies for ${cookiesFile.split(path.sep).pop()}`);
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
    } else if (url.includes('weibo.com') || url.includes('weibo.cn')) {
      result = await extractWeibo(page, url, timeout);
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
 * 通用 DOM 兜底：从页面 DOM 提取视频 URL。
 * video 元素 src、source src、或 script 内嵌的 mp4/m3u8 链接。
 */
async function extractVideoFromDom(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    if (v && v.src) return v.src;
    const s = document.querySelector('video source');
    if (s && s.src) return s.src;
    const scripts = document.querySelectorAll('script');
    for (const sc of scripts) {
      const t = sc.textContent || '';
      const m = t.match(/https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*/);
      if (m) return m[0];
    }
    return null;
  });
}

/**
 * 轮询等待直到抓到视频 URL，或超时。
 * 替代各平台提取函数里"固定 waitForTimeout"的碰运气做法：
 * 已有 route 监听异步写 state.videoUrl；这里每 600ms 兜底从 DOM 提取一次，
 * 直到 state.videoUrl 非空或达到 timeoutMs。
 */
async function pollForVideoUrl(page, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!state.videoUrl && Date.now() < deadline) {
    if (!state.videoUrl) {
      const dom = await extractVideoFromDom(page).catch(() => null);
      if (dom) state.videoUrl = decodeVideoUrl(dom);
    }
    if (state.videoUrl) break;
    await new Promise(r => setTimeout(r, 600));
  }
  return state.videoUrl || null;
}

/**
 * 快手提取 — 监听 API 响应，提取视频 URL。
 */
async function extractKuaishou(page, url, timeout) {
  const state = { videoUrl: null, videoTitle: '快手视频' };
  let responseCount = 0;

  // 从页面 URL 中提取视频 ID（用于验证找到的 URL 是否匹配当前页面）
  const pageVideoId = url.match(/\/([a-zA-Z0-9]+)$/)?.[1] || '';

  // 被动监听所有响应，不拦截请求
  page.on('response', async (response) => {
    if (state.videoUrl) return; // 已找到，不再处理
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
          state.videoUrl = found;
          console.log(`[playwright] Kuaishou photoUrl: ${state.videoUrl.substring(0, 100)}`);
        }
      }

      // 2. 如果没找到 photoUrl，尝试其他视频 URL 模式
      if (!state.videoUrl) {
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
              state.videoUrl = found;
              console.log(`[playwright] Kuaishou URL found: ${state.videoUrl.substring(0, 100)}`);
              break;
            }
          }
        }
      }

      // 3. 提取标题
      if (!state.videoTitle || state.videoTitle === '快手视频') {
        const tm = body.match(/"caption"\s*:\s*"([^"]+)"/);
        if (tm) state.videoTitle = tm[1].slice(0, 100);
      }
    } catch {}
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {
    console.log('[playwright] Kuaishou page load timeout, continuing with loaded data');
  });
  await pollForVideoUrl(page, state, timeout);
  console.log(`[playwright] Kuaishou page loaded, ${responseCount} responses checked, videoUrl=${state.videoUrl ? 'yes' : 'no'}`);

  return { videoUrl: state.videoUrl, title: state.videoTitle, platform: '快手' };
}

/**
 * 豆包提取 — 拦截 get_play_info / get_download_info API。
 */
async function extractDoubao(page, url, timeout) {
  const state = { videoUrl: null, videoTitle: '豆包视频' };

  // 拦截 samantha API
  await page.route('**/samantha/**', async (route) => {
    let response;
    try {
      response = await route.fetch();
    } catch (err) {
      try { await route.continue(); } catch {}
      return;
    }
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
          state.videoUrl = (m[1] || m[0]).replace(/\\u0026/g, '&').replace(/\\/g, '');
          console.log(`[playwright] Doubao URL found: ${state.videoUrl.substring(0, 80)}`);
          break;
        }
      }
      const titleMatch = body.match(/"title"\s*:\s*"([^"]+)"/);
      if (titleMatch) state.videoTitle = titleMatch[1];
    } catch {}
    route.fulfill({ response });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await pollForVideoUrl(page, state, timeout);

  return { videoUrl: state.videoUrl, title: state.videoTitle, platform: '豆包' };
}

/**
 * 抖音提取 — 拦截视频 API 响应。
 */
async function extractDouyin(page, url, timeout) {
  const state = { videoUrl: null, videoTitle: '抖音视频' };

  await page.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    // 跳过非 http(s) 资源，避免 route.fetch() 因 chrome-extension:// 协议抛错崩溃
    if (!/^https?:\/\//i.test(reqUrl)) {
      try { await route.continue(); } catch {}
      return;
    }
    let response;
    try {
      response = await route.fetch();
    } catch (err) {
      try { await route.continue(); } catch {}
      return;
    }
    if (!state.videoUrl) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await response.text();
          // 抖音视频 URL 模式
          const m = body.match(/https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*/);
          if (m) state.videoUrl = m[0];
        }
      } catch {}
    }
    route.fulfill({ response });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await pollForVideoUrl(page, state, timeout);

  return { videoUrl: state.videoUrl, title: state.videoTitle, platform: '抖音' };
}

/**
 * 小红书提取 — 拦截 API 响应获取笔记数据（支持视频和图文）。
 */
async function extractXiaohongshu(page, url, timeout) {
  const state = { videoUrl: null, videoTitle: '小红书笔记', author: '', description: '' };

  // 拦截所有请求，从 API 响应中提取笔记数据
  await page.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    // 跳过非 http(s) 资源（chrome-extension://、blob: 等），否则 route.fetch() 会抛
    // "Protocol chrome-extension: not supported" 导致整个提取 Unhandled Rejection 崩溃
    if (!/^https?:\/\//i.test(reqUrl)) {
      try { await route.continue(); } catch {}
      return;
    }
    let response;
    try {
      response = await route.fetch();
    } catch (err) {
      // 网络/协议错误：放行原请求，避免整个提取崩溃
      console.log(`[playwright] route.fetch failed for ${reqUrl.slice(0, 80)}: ${err.message || err}`);
      try { await route.continue(); } catch {}
      return;
    }
    if (!state.videoUrl) {
      try {
        const ct = response.headers()['content-type'] || '';
        // 关注 JSON 响应和 JavaScript 响应（可能包含内嵌数据）
        if (ct.includes('json') || ct.includes('javascript')) {
          const body = await response.text();
          if (body && body.length > 100) {
            // 提取视频 URL
            const vMatch = body.match(/https?:\/\/[^"'\s,]+\.(?:mp4|m3u8)[^"'\s,]*/);
            if (vMatch) state.videoUrl = vMatch[0];

            // 提取标题/描述
            const descMatch = body.match(/"display_title"\s*:\s*"([^"]+)"/);
            if (descMatch && !state.description) state.description = descMatch[1];
            if (!state.description) {
              const dMatch = body.match(/"desc"\s*:\s*"([^"]+)"/);
              if (dMatch) state.description = dMatch[1];
            }

            // 提取作者
            const aMatch = body.match(/"nickname"\s*:\s*"([^"]+)"/);
            if (aMatch && !state.author) state.author = aMatch[1];
          }
        }
      } catch {}
    }
    route.fulfill({ response });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await pollForVideoUrl(page, state, timeout);

  return { videoUrl: state.videoUrl, title: state.videoTitle, author: state.author, description: state.description, platform: '小红书' };
}

/**
 * 微博提取 — 打开页面，从 video 元素或页面数据中提取视频 URL。
 */
async function extractWeibo(page, url, timeout) {
  const state = { videoUrl: null, videoTitle: '', author: '' };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout || 15000 }).catch(() => {
    console.log('[playwright] Weibo page load timeout, continuing with loaded data');
  });

  // 轮询等待，直到从页面 DOM/数据中提取到视频 URL（微博无稳定的 JSON 拦截，靠 DOM 兜底）
  const deadline = Date.now() + (timeout || 45000);
  while (!state.videoUrl && Date.now() < deadline) {
    state.videoUrl = await page.evaluate(() => {
      // 1. video 元素
      const v = document.querySelector('video');
      if (v && v.src) return v.src;
      const s = document.querySelector('video source');
      if (s && s.src) return s.src;
      // 2. 页面中 video_url 数据
      const scripts = document.querySelectorAll('script');
      for (const sc of scripts) {
        const text = sc.textContent || '';
        // 匹配 video_url 或 mp4 链接
        const m = text.match(/video_url["']?\s*[:=]\s*["']([^"']+\.mp4[^"']*)["']/);
        if (m) return m[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
      }
      // 3. 视频 URL 正则
      const html = document.documentElement.innerHTML;
      const m = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
      if (m) return m[0];
      return null;
    }).catch(() => null);
    if (state.videoUrl) break;
    await new Promise(r => setTimeout(r, 600));
  }

  // 提取标题
  try {
    state.videoTitle = await page.evaluate(() => {
      const t = document.querySelector('title');
      if (t) return t.textContent?.split(' - ')[0]?.trim() || '';
      return '';
    });
  } catch {}

  return { videoUrl: state.videoUrl, title: state.videoTitle, author: state.author, platform: '微博' };
}

module.exports = { extractVideo, closeBrowser, getBrowser };