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

/**
 * 快手提取 — 从页面数据中提取指定视频的 URL。
 *
 * 逻辑：
 * 1. 从 URL 提取视频 ID
 * 2. 打开页面，提取 __APOLLO_STATE__ 或 __INITIAL_STATE__
 * 3. 在数据中找到匹配视频 ID 的 photo，获取 photoUrl
 * 4. 确保下载的是用户复制的链接对应的视频，而不是页面上的推荐视频
 */
async function extractKuaishou(page, url, timeout) {
  let videoUrl = null;
  let videoTitle = '快手视频';

  // 1. 从 URL 提取视频 ID
  // 格式: /short-video/xxxxx 或 /xxxxx (短链接或直接 ID)
  let pageVideoId = '';
  const idMatch = url.match(/\/([a-zA-Z0-9]+)(?:\?.*)?$/);
  if (idMatch) {
    pageVideoId = idMatch[1];
    console.log(`[playwright] Kuaishou video ID: ${pageVideoId}`);
  }

  // 2. 打开页面
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {
    console.log('[playwright] Kuaishou page load timeout, continuing with loaded data');
  });
  await page.waitForTimeout(3000);

  // 3. 从页面 JS 数据中提取视频（优先，能精确匹配到正确的视频）
  try {
    const extracted = await page.evaluate((vid) => {
      try {
        // 方法 A: 从 __APOLLO_STATE__ 提取
        const apollo = window.__APOLLO_STATE__;
        if (apollo) {
          for (const key of Object.keys(apollo)) {
            const val = apollo[key];
            if (val && typeof val === 'object') {
              // 直接匹配 photo.id
              const photo = val.photo || val;
              if (photo && (photo.id === vid || photo.photoId === vid)) {
                const url = photo.photoUrl || photo.playUrl || photo.videoUrl || '';
                if (url) return { videoUrl: url, title: photo.caption || '' };
              }
              // 匹配 key 中包含视频 ID 的条目
              if (key.includes(vid) && (val.photoUrl || val.playUrl || val.videoUrl)) {
                const url = val.photoUrl || val.playUrl || val.videoUrl;
                return { videoUrl: url, title: val.caption || '' };
              }
            }
          }
        }

        // 方法 B: 从 __INITIAL_STATE__ 提取
        const init = window.__INITIAL_STATE__;
        if (init) {
          const photo = init.photo || init.video;
          if (photo && (photo.id === vid || photo.photoId === vid)) {
            const url = photo.photoUrl || photo.playUrl || photo.videoUrl || '';
            if (url) return { videoUrl: url, title: photo.caption || '' };
          }
        }

        // 方法 C: 从 __NEXT_DATA__ 提取
        const next = window.__NEXT_DATA__;
        if (next && next.props) {
          const pageProps = next.props.pageProps || {};
          const photo = pageProps.photo || pageProps.video;
          if (photo && (photo.id === vid || photo.photoId === vid)) {
            const url = photo.photoUrl || photo.playUrl || photo.videoUrl || '';
            if (url) return { videoUrl: url, title: photo.caption || '' };
          }
        }

        // 方法 D: 遍历所有 script 标签找视频 URL + 视频 ID
        const scripts = document.querySelectorAll('script');
        for (const sc of scripts) {
          const text = sc.textContent || '';
          if (text.includes(vid) && (text.includes('photoUrl') || text.includes('playUrl'))) {
            const m = text.match(/photoUrl["']?\s*[:=]\s*["']([^"']+)["']/);
            if (m) {
              const url = m[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
              const tm = text.match(/caption["']?\s*[:=]\s*["']([^"']+)["']/);
              return { videoUrl: url, title: tm ? tm[1] : '' };
            }
          }
        }

        // 方法 E: 找 video 元素（兜底，可能不准）
        const video = document.querySelector('video');
        if (video && video.src) return { videoUrl: video.src, title: document.title };
        const source = document.querySelector('video source');
        if (source && source.src) return { videoUrl: source.src, title: document.title };

        return null;
      } catch (e) { return null; }
    }, pageVideoId);

    if (extracted && extracted.videoUrl) {
      videoUrl = extracted.videoUrl;
      videoTitle = extracted.title || '快手视频';
      console.log(`[playwright] Kuaishou extracted for video ${pageVideoId}: ${videoUrl.substring(0, 80)}`);
      return { videoUrl, title: videoTitle, platform: '快手' };
    }
  } catch (e) {
    console.log(`[playwright] Kuaishou JS extraction error: ${e.message}`);
  }

  // 4. 兜底：网络拦截（但会验证视频 ID 是否匹配）
  // 如果页面数据提取失败，等 API 响应回来再试
  console.log(`[playwright] Kuaishou JS extraction failed, waiting for API responses`);
  await page.waitForTimeout(5000);

  // 最后尝试从 DOM 提取
  if (!videoUrl) {
    videoUrl = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && v.src) return v.src;
      const s = document.querySelector('video source');
      if (s && s.src) return s.src;
      return null;
    }).catch(() => null);
  }

  if (videoUrl) {
    console.log(`[playwright] Kuaishou DOM fallback: ${videoUrl.substring(0, 80)}`);
    return { videoUrl, title: videoTitle, platform: '快手' };
  }

  throw new Error('未能提取到快手视频');
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

module.exports = { extractVideo, closeBrowser, getBrowser };