/**
 * yt-dlp wrapper — video info parsing and downloading.
 *
 * Uses yt-dlp CLI as subprocess to handle all platforms
 * (Douyin, TikTok, Kuaishou, Bilibili, YouTube, etc.)
 *
 * For Douyin URLs, tries proxy APIs first (no cookies needed),
 * then falls back to yt-dlp.
 *
 * yt-dlp automatically:
 *   - Detects the platform from the URL
 *   - Fetches non-watermarked video streams
 *   - Gets best quality available
 */
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { resolveDouyin, isDouyinUrl } = require('./douyinProxy');

/** Resolve yt-dlp binary path. */
function _ytdlpPath() {
  // Check common locations
  const candidates = [
    'yt-dlp',  // in PATH
    path.join(config.projectDir, '..', 'OpenMontage', '.venv', 'Scripts', 'yt-dlp'),
    path.join(config.projectDir, '..', '.venv', 'Scripts', 'yt-dlp'),
  ];
  return candidates;
}

function _findYtdlp() {
  // Will be resolved at runtime
  return 'yt-dlp';
}

/**
 * Parse video info from a URL using yt-dlp --dump-json.
 * Returns structured video metadata.
 */
function parseVideoInfo(url, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      '--no-playlist',
      '--flat',
    ];

    // Add cookies file if provided
    if (options.cookiesFile) {
      args.push('--cookies', options.cookiesFile);
    }

    args.push(url);

    execFile(_findYtdlp(), args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const stderrStr = stderr?.toString() || '';
        const msg = stderrStr.includes('Unsupported URL')
          ? '不支持的视频链接，请检查链接是否正确'
          : stderrStr.includes('HTTP Error')
            ? '无法访问该视频，可能已被删除或设为私密'
            : stderrStr.includes('Private video')
              ? '该视频为私密视频，无法访问'
              : `解析失败: ${err.message}`;
        return reject(new Error(msg));
      }

      try {
        const data = JSON.parse(stdout.toString());

        // Map yt-dlp fields to standardized video info
        const info = {
          title: (data.title || 'Untitled').slice(0, 200),
          author: data.uploader || data.channel || data.creator || 'Unknown',
          duration: data.duration || 0,
          thumbnailUrl: data.thumbnail || null,
          platform: data.extractor_key?.toLowerCase() || 'unknown',
          videoId: data.id || '',
          webpageUrl: data.webpage_url || url,
          width: data.width || 0,
          height: data.height || 0,
          // yt-dlp returns direct stream URLs when --flat is not used
          // For quality selection, we store available formats
          formats: data.formats || [],
          // Best direct URL (non-watermarked for Douyin etc.)
          directUrl: data.url || null,
          // Platform display name
          platformLabel: _platformLabel(data.extractor_key || ''),
        };

        resolve(info);
      } catch (parseErr) {
        reject(new Error(`解析响应失败: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Full video info with format selection.
 * For Douyin URLs, tries proxy API first, then falls back to yt-dlp.
 */
async function getVideoInfo(url, options = {}) {
  // For Douyin URLs, try proxy API first (no cookies needed)
  if (isDouyinUrl(url)) {
    console.log(`[ytdlp] Detected Douyin URL, trying proxy API first`);
    try {
      const proxyResult = await resolveDouyin(url);
      if (proxyResult) {
        console.log(`[ytdlp] Douyin proxy API succeeded`);
        return proxyResult;
      }
    } catch (err) {
      console.log(`[ytdlp] Douyin proxy API failed, falling back to yt-dlp: ${err.message}`);
    }
  }

  // Fallback to yt-dlp
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      '--no-playlist',
    ];

    if (options.cookiesFile) {
      args.push('--cookies', options.cookiesFile);
    }

    args.push(url);

    execFile(_findYtdlp(), args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const stderrStr = stderr?.toString() || '';
        const msg = stderrStr.includes('Unsupported URL')
          ? '不支持的视频链接'
          : stderrStr.includes('HTTP Error')
            ? '无法访问该视频'
            : stderrStr.includes('Private video')
              ? '该视频为私密视频'
              : `解析失败: ${err.message}`;
        return reject(new Error(msg));
      }

      try {
        const data = JSON.parse(stdout.toString());

        // Find the best non-watermarked format
        // For most platforms, yt-dlp's default format selection works
        let bestUrl = data.url;

        // If formats are available, pick the best one
        if (data.formats && data.formats.length > 0) {
          // Prefer video-only + audio formats (higher quality)
          // Sort by quality (height) descending
          const sorted = [...data.formats]
            .filter(f => f.vcodec !== 'none' && f.url)
            .sort((a, b) => (b.height || 0) - (a.height || 0));

          if (sorted.length > 0) {
            bestUrl = sorted[0].url;
          }
        }

        const info = {
          title: (data.title || 'Untitled').slice(0, 200),
          author: data.uploader || data.channel || data.creator || 'Unknown',
          duration: data.duration || 0,
          thumbnailUrl: data.thumbnail || null,
          platform: data.extractor_key?.toLowerCase() || 'unknown',
          platformLabel: _platformLabel(data.extractor_key || ''),
          videoId: data.id || '',
          webpageUrl: data.webpage_url || url,
          width: data.width || 0,
          height: data.height || 0,
          directUrl: bestUrl || '',
          hasOriginal: !!bestUrl,
        };

        resolve(info);
      } catch (parseErr) {
        reject(new Error(`解析响应失败: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Download a video to a local file.
 * For Douyin URLs, tries proxy API first, then falls back to yt-dlp.
 * Returns a Promise that resolves with the output path.
 */
async function downloadVideo(url, outputPath, options = {}) {
  // For Douyin URLs, try proxy API first
  if (isDouyinUrl(url)) {
    console.log(`[ytdlp] Downloading Douyin video, trying proxy API first`);
    try {
      const proxyResult = await resolveDouyin(url);
      if (proxyResult && proxyResult.directUrl) {
        console.log(`[ytdlp] Downloading from proxy URL: ${proxyResult.directUrl}`);
        return await downloadFromUrl(proxyResult.directUrl, outputPath);
      }
    } catch (err) {
      console.log(`[ytdlp] Douyin proxy download failed, falling back to yt-dlp: ${err.message}`);
    }
  }

  // Fallback to yt-dlp
  return new Promise((resolve, reject) => {
    // yt-dlp handles watermarks by default — it fetches the original stream
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '-o', outputPath.replace(/\.mp4$/, '.%(ext)s'),
    ];

    // Force mp4 format for compatibility
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');

    if (options.cookiesFile) {
      args.push('--cookies', options.cookiesFile);
    }

    // Add referer for platforms that need it
    args.push('--add-header', 'Referer:https://www.douyin.com/');

    args.push(url);

    const proc = spawn(_findYtdlp(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000, // 5 min
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        // yt-dlp may output to a different extension
        const base = outputPath.replace(/\.mp4$/, '');
        const possible = fs.readdirSync(path.dirname(outputPath))
          .filter(f => f.startsWith(path.basename(base)));
        if (possible.length > 0) {
          resolve(path.join(path.dirname(outputPath), possible[0]));
        } else {
          resolve(outputPath);
        }
      } else {
        reject(new Error(stderr.slice(0, 200) || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`yt-dlp launch failed: ${err.message}`));
    });
  });
}

/**
 * Download a video from a direct URL using ffmpeg.
 * Used as fallback when proxy API provides a direct video URL.
 */
function downloadFromUrl(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-i', videoUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(stderr.slice(0, 200) || `ffmpeg download failed with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg download failed: ${err.message}`));
    });
  });
}

/**
 * Extract audio from a video file for speech-to-text.
 */
function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      audioPath,
    ];

    execFile('ffmpeg', args, { timeout: 300000 }, (err) => {
      if (err) return reject(new Error(`音频提取失败: ${err.message}`));
      resolve(audioPath);
    });
  });
}

function _platformLabel(extractor) {
  const labels = {
    DOUYIN: '抖音',
    TIKTOK: 'TikTok',
    KUAISHOU: '快手',
    BILIBILI: 'B站',
    YOUTUBE: 'YouTube',
    INSTAGRAM: 'Instagram',
    TWITTER: 'Twitter/X',
    WEIBO: '微博',
    XIAOHONGSHU: '小红书',
  };
  return labels[extractor?.toUpperCase()] || extractor || '其他';
}

module.exports = { parseVideoInfo, getVideoInfo, downloadVideo, extractAudio };