/**
 * Doubao video service - resolves Doubao video sharing URLs.
 *
 * Uses the Doubao internal API: POST /samantha/media/get_play_info
 * Requires valid cookies from a logged-in Doubao session.
 */
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const API_URL = 'https://www.doubao.com/samantha/media/get_play_info';
const API_PARAMS = 'version_code=20800&language=zh-CN&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=&pc_version=2.51.7&region=&sys_region=&samantha_web=1&use-olympus-account=1&web_tab_id=';

/**
 * Extract video_id from a Doubao share URL.
 */
function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    const vid = parsed.searchParams.get('video_id');
    return vid || null;
  } catch {
    return null;
  }
}

/**
 * Check if a URL is a Doubao video sharing URL.
 */
function isDoubaoUrl(url) {
  return url && (url.includes('doubao.com/video-sharing') || url.includes('doubao.com/share'));
}

/**
 * Read cookies from the project's cookies.txt file.
 * Returns a cookie string suitable for the Cookie header.
 */
function readCookies() {
  const cookiesPath = path.join(config.projectDir, 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) {
    // Also try alternate location
    const altPath = path.join(config.serverDir, 'cookies.txt');
    if (fs.existsSync(altPath)) {
      return readCookiesFile(altPath);
    }
    return '';
  }
  return readCookiesFile(cookiesPath);
}

function readCookiesFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const valid = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Netscape cookie format: domain, flag, path, secure, expiry, name, value
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const name = parts[5]?.trim();
        const value = parts[6]?.trim();
        if (name && value) {
          valid.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
        }
      }
    }
    const cookieStr = valid.join('; ');
    console.log(`[doubao] 读取到 ${valid.length} 个 cookie`);
    return cookieStr;
  } catch (e) {
    console.error(`[doubao] 读取 cookies 失败: ${e.message}`);
    return '';
  }
}

/**
 * 从响应 body 中提取视频 URL（尝试多种字段路径）
 */
function extractVideoUrlFromResponse(json) {
  if (!json || !json.data) return null;

  const data = json.data;

  // 路径 1: original_media_info
  if (data.original_media_info) {
    const om = data.original_media_info;
    if (om.main_url) {
      const url = om.main_url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
      return {
        title: '豆包视频',
        author: '豆包AI',
        duration: om.meta?.duration || data.media_info?.[0]?.meta?.duration || 0,
        thumbnailUrl: data.poster_url || null,
        platform: '豆包',
        platformLabel: '豆包',
        videoId: json.key || '',
        webpageUrl: '',
        directUrl: url,
        hasOriginal: true,
        width: om.meta?.width || om.width || 0,
        height: om.meta?.height || om.height || 0,
      };
    }
  }

  // 路径 2: play_infos 数组
  const playInfos = data.play_infos || (data.play_info ? [data.play_info] : []);
  if (playInfos.length > 0) {
    const pi = playInfos[0];
    if (pi && pi.main) {
      return {
        title: '豆包视频',
        author: '豆包AI',
        duration: pi.meta?.duration || 0,
        thumbnailUrl: data.poster_url || null,
        platform: '豆包',
        platformLabel: '豆包',
        videoId: json.key || '',
        webpageUrl: '',
        directUrl: pi.main.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark'),
        hasOriginal: true,
        width: pi.width || 0,
        height: pi.height || 0,
      };
    }
  }

  // 路径 3: media_info 数组
  if (data.media_info && Array.isArray(data.media_info)) {
    for (const mi of data.media_info) {
      if (mi && mi.main_url) {
        return {
          title: '豆包视频',
          author: '豆包AI',
          duration: mi.meta?.duration || 0,
          thumbnailUrl: mi.poster_url || data.poster_url || null,
          platform: '豆包',
          platformLabel: '豆包',
          videoId: json.key || '',
          webpageUrl: '',
          directUrl: mi.main_url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark'),
          hasOriginal: true,
          width: mi.meta?.width || mi.width || 0,
          height: mi.meta?.height || mi.height || 0,
        };
      }
    }
  }

  // 路径 4: video_info
  if (data.video_info && data.video_info.main_url) {
    return {
      title: '豆包视频',
      author: '豆包AI',
      duration: data.video_info.duration || 0,
      thumbnailUrl: data.poster_url || null,
      platform: '豆包',
      platformLabel: '豆包',
      videoId: json.key || '',
      webpageUrl: '',
      directUrl: data.video_info.main_url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark'),
      hasOriginal: true,
      width: data.video_info.width || 0,
      height: data.video_info.height || 0,
    };
  }

  return null;
}

/**
 * 发起 HTTPS 请求
 */
function httpsRequest(urlStr, postData, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOpts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.doubao.com',
        'Referer': 'https://www.doubao.com/video-sharing',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Cookie': options.cookies || '',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: options.timeout || 15000,
    };

    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`解析响应失败: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.on('error', (e) => {
      reject(new Error(`请求失败: ${e.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Call the Doubao API to get video play info.
 * @param {string} videoId - The video_id from the share URL
 * @returns {Promise<object>} - { title, author, duration, thumbnailUrl, directUrl, ... }
 */
async function getPlayInfo(videoId) {
  const cookies = readCookies();
  if (!cookies) {
    throw new Error('未找到 cookies.txt，请先登录豆包后导出 cookies');
  }

  const endpoints = [
    { url: API_URL + '?' + API_PARAMS, body: { key: videoId, type: 'video' } },
    { url: API_URL + '?' + API_PARAMS, body: { key: videoId, type: 'video_gen' } },
    { url: 'https://www.doubao.com/creativity/video/get_play_info?' + API_PARAMS, body: { key: videoId, type: 'video' } },
  ];

  let lastError = null;
  for (const ep of endpoints) {
    try {
      const postData = JSON.stringify(ep.body);
      const json = await httpsRequest(ep.url, postData, { cookies, timeout: 10000 });

      if (json.code !== 0) {
        lastError = new Error(`豆包API返回错误: code=${json.code}, msg=${json.msg || '未知'}`);
        continue;
      }

      const result = extractVideoUrlFromResponse(json);
      if (result) {
        result.videoId = videoId;
        result.webpageUrl = `https://www.doubao.com/video-sharing?share_scene=video_viewer&video_id=${videoId}`;
        console.log(`[doubao] 成功获取无水印视频: ${result.directUrl ? result.directUrl.substring(0, 60) + '...' : '无URL'}`);
        return result;
      }

      lastError = new Error('响应中未找到视频地址');
    } catch (e) {
      lastError = e;
      console.warn(`[doubao] 端点失败: ${ep.url.substring(0, 60)}... - ${e.message}`);
    }
  }

  throw lastError || new Error('所有API端点均失败');
}

module.exports = { getPlayInfo, extractVideoId, isDoubaoUrl };