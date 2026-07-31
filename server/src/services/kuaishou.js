/**
 * Kuaishou video service - resolves Kuaishou video URLs.
 *
 * Uses Playwright (via extract_video.py) to open the Kuaishou page
 * and extract the video URL from the page data.
 */
const { execFile } = require('child_process');
const path = require('path');
const config = require('../config');

/**
 * Extract video ID from a Kuaishou URL.
 */
function extractVideoId(url) {
  const m = url.match(/kuaishou\.com\/(?:short-video\/)?([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function isKuaishouUrl(url) {
  return url && (url.includes('kuaishou.com') || url.includes('gifshow.com'));
}

/**
 * Get video info using Playwright (extract_video.py).
 * This opens the Kuaishou page in a headless browser and extracts the video URL.
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.projectDir, 'extract_video.py');
    console.log(`[kuaishou] Calling extract_video.py for: ${url}`);

    const proc = execFile('C:/Python311/python.exe', [scriptPath, url], {
      timeout: 45000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        console.log(`[kuaishou] extract_video.py failed: ${err.message}`);
        // Try to parse partial output
        if (stdout) {
          try {
            const result = JSON.parse(stdout);
            if (result.video_url) {
              console.log(`[kuaishou] Got video URL from partial output`);
              return resolve(formatResult(result));
            }
          } catch {}
        }
        return reject(new Error('快手解析失败: ' + (err.message || '未知错误')));
      }

      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          return reject(new Error(result.error));
        }
        if (!result.video_url) {
          return reject(new Error('未找到视频地址'));
        }
        console.log(`[kuaishou] Successfully extracted video URL`);
        resolve(formatResult(result));
      } catch (e) {
        reject(new Error(`解析快手响应失败: ${e.message}`));
      }
    });

    // Log stderr for debugging
    proc.stderr?.on('data', (data) => {
      console.log(`[kuaishou] ${data.toString().trim()}`);
    });
  });
}

function formatResult(result) {
  return {
    title: result.title || '快手视频',
    author: result.author || 'Unknown',
    duration: result.duration || 0,
    thumbnailUrl: result.thumbnail || '',
    platform: '快手',
    platformLabel: '快手',
    videoId: '',
    webpageUrl: '',
    directUrl: result.video_url || '',
    hasOriginal: !!result.video_url,
  };
}

module.exports = { getVideoInfo, extractVideoId, isKuaishouUrl };