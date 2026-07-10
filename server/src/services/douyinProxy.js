/**
 * Douyin proxy API service - resolves Douyin URLs via multiple methods:
 * 1. External proxy APIs (HTTP)
 * 2. Local Python API (yt-dlp based) - the most reliable method
 *
 * Tries methods in sequence until one succeeds.
 */
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');

/** Local Python API script path (uses yt-dlp). */
const LOCAL_PYTHON_API = path.join(config.projectDir, 'douyin-api.py');

/** Known free Douyin proxy API templates (external). */
const DEFAULT_PROXY_APIS = [
  'https://api.douyin.wtf/api/convert?url={url}',
  'https://api.douyin.wtf/api/video?url={url}',
  'https://ttsl.moe/api/douyin?url={url}',
  'https://www.douyin.wtf/api/video?url={url}',
  'https://api.douyin.wtf/api/info?url={url}',
];

/**
 * Fetch JSON from a URL with timeout.
 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch {
          reject(new Error(`Invalid JSON response from ${url}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });

    req.on('error', reject);
  });
}

/**
 * Try to resolve a Douyin URL using local Python API (yt-dlp based).
 * This is the most reliable method - it uses yt-dlp directly with cookies.
 */
function resolveWithLocalAPI(url) {
  return new Promise((resolve, reject) => {
    const scriptPath = LOCAL_PYTHON_API;
    if (!fs.existsSync(scriptPath)) {
      reject(new Error('Local Python API script not found'));
      return;
    }

    execFile('python', [scriptPath, url], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Local API error: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (data.error) {
          reject(new Error(data.error));
          return;
        }
        resolve({
          title: data.title || '',
          author: data.author || '',
          duration: parseInt(data.duration || '0', 10),
          thumbnailUrl: data.thumbnail || '',
          platform: '抖音',
          videoId: '',
          webpageUrl: url,
          directUrl: data.video_url || '',
          hasOriginal: !!data.video_url,
        });
      } catch {
        reject(new Error(`Failed to parse local API response: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Parse proxy API response into standardized video info.
 * Different APIs return different formats - try to extract common fields.
 */
function parseProxyResponse(data, url) {
  if (data && typeof data === 'object') {
    // Try common response patterns
    if (data.title) {
      return {
        title: data.title || '',
        author: data.author || data.nickname || data.username || data.creator || '',
        duration: parseInt(data.duration || data.length || data.video_duration || '0', 10),
        thumbnailUrl: data.thumbnail || data.cover || data.preview || data.image || data.origin_cover_url || '',
        platform: '抖音',
        videoId: data.id || data.vid || '',
        webpageUrl: url,
        directUrl: data.video_url || data.url || data.play_url || data.wmplay_url || data.download_url || '',
        hasOriginal: true,
      };
    }

    // Try response.data wrapper
    if (data.data) {
      const inner = data.data;
      if (inner.title || inner.video_url || inner.play_url) {
        return {
          title: inner.title || '',
          author: inner.author || inner.nickname || inner.username || '',
          duration: parseInt(inner.duration || inner.length || '0', 10),
          thumbnailUrl: inner.thumbnail || inner.cover || inner.preview || '',
          platform: '抖音',
          videoId: inner.id || inner.vid || '',
          webpageUrl: url,
          directUrl: inner.video_url || inner.url || inner.play_url || inner.wmplay_url || '',
          hasOriginal: true,
        };
      }
    }

    // Try response with success flag
    if (data.success === true || data.code === 0 || data.code === 200 || data.code === '0') {
      const inner = data.data || data.result || data.response || data.item;
      if (inner && typeof inner === 'object') {
        return {
          title: inner.title || inner.desc || '',
          author: inner.author || inner.nickname || inner.username || '',
          duration: parseInt(inner.duration || inner.length || '0', 10),
          thumbnailUrl: inner.thumbnail || inner.cover || inner.preview || '',
          platform: '抖音',
          videoId: inner.id || inner.vid || '',
          webpageUrl: url,
          directUrl: inner.video_url || inner.url || inner.play_url || inner.wmplay_url || '',
          hasOriginal: true,
        };
      }
    }

    // Try data with video field
    if (data.video && typeof data.video === 'object') {
      const v = data.video;
      return {
        title: v.title || v.desc || data.title || '',
        author: v.author || v.nickname || data.author || '',
        duration: parseInt(v.duration || v.length || '0', 10),
        thumbnailUrl: v.thumbnail || v.cover || data.thumbnail || '',
        platform: '抖音',
        videoId: v.id || v.vid || '',
        webpageUrl: url,
        directUrl: v.url || v.play_url || v.video_url || '',
        hasOriginal: true,
      };
    }
  }

  return null;
}

/**
 * Try to resolve a Douyin URL using multiple methods.
 * @param {string} url - Douyin video URL
 * @returns {Promise<object|null>} - Parsed video info or null if all methods fail
 */
async function resolveDouyin(url) {
  // Method 1: Try external proxy APIs first
  const proxyApis = config.douyinProxyAPIs.length > 0
    ? config.douyinProxyAPIs
    : DEFAULT_PROXY_APIS;

  for (const apiTemplate of proxyApis) {
    try {
      const apiUrl = apiTemplate.replace('{url}', encodeURIComponent(url));
      console.log(`[douyin-proxy] Trying external: ${apiUrl}`);

      const data = await fetchJSON(apiUrl);
      const result = parseProxyResponse(data, url);

      if (result && (result.title || result.directUrl)) {
        console.log(`[douyin-proxy] External success: title="${result.title}" directUrl="${result.directUrl ? 'yes' : 'no'}"`);
        return result;
      }
    } catch (err) {
      console.log(`[douyin-proxy] External failed: ${err.message}`);
      continue;
    }
  }

  // Method 2: Try local Python API (yt-dlp based)
  console.log(`[douyin-proxy] Trying local Python API...`);
  try {
    const result = await resolveWithLocalAPI(url);
    if (result && (result.title || result.directUrl)) {
      console.log(`[douyin-proxy] Local API success: title="${result.title}" directUrl="${result.directUrl ? 'yes' : 'no'}"`);
      return result;
    }
  } catch (err) {
    console.log(`[douyin-proxy] Local API failed: ${err.message}`);
  }

  console.log(`[douyin-proxy] All methods failed for ${url}`);
  return null;
}

/**
 * Check if a URL is a Douyin URL.
 */
function isDouyinUrl(url) {
  const patterns = [
    /douyin\.com/,
    /iesdouyin\.com/,
    /douyin\.com\/user/,
  ];
  return patterns.some(p => p.test(url));
}

module.exports = {
  resolveDouyin,
  isDouyinUrl,
  fetchJSON,
};
