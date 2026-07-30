/**
 * Kuaishou video service - resolves Kuaishou video URLs.
 *
 * Uses the Kuaishou internal API with cookies from cookies.txt.
 * Falls back to bridge if API is not available.
 */
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const config = require('../config');

/**
 * Extract video ID from a Kuaishou URL.
 * Format: https://www.kuaishou.com/short-video/{videoId}
 *         https://v.kuaishou.com/{videoId}
 */
function extractVideoId(url) {
  const m = url.match(/kuaishou\.com\/(?:short-video\/)?([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function isKuaishouUrl(url) {
  return url && (url.includes('kuaishou.com') || url.includes('gifshow.com'));
}

/**
 * Read cookies from cookies.txt.
 */
function readCookies() {
  const cookiesPath = path.join(config.projectDir, 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) return '';
  try {
    const content = fs.readFileSync(cookiesPath, 'utf-8');
    const valid = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7 && (parts[0].includes('kuaishou') || parts[0].includes('gifshow'))) {
        valid.push(`${encodeURIComponent(parts[5])}=${encodeURIComponent(parts[6])}`);
      }
    }
    return valid.join('; ');
  } catch { return ''; }
}

/**
 * Try to get video info from Kuaishou page.
 * Kuaishou is a dynamic SPA, so we try multiple approaches.
 */
async function getVideoInfo(videoId) {
  // Method 1: Try the photo detail API
  try {
    const result = await _callAPI('https://www.kuaishou.com/rest/v2/photo/detail', {
      photoId: videoId,
      isShortVideo: 'true',
    });
    if (result && result.photo) return result;
  } catch {}

  // Method 2: Try the feed API
  try {
    const result = await _callAPI('https://www.kuaishou.com/rest/v2/feed/photo', {
      photoId: videoId,
      type: 'shortVideo',
    });
    if (result && result.photo) return result;
  } catch {}

  return null;
}

function _callAPI(apiUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
    const postData = JSON.stringify(body);
    const cookies = readCookies();

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.kuaishou.com/',
        'Cookie': cookies || 'kpf=PC_WEB; clientid=3',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = { getVideoInfo, extractVideoId, isKuaishouUrl };