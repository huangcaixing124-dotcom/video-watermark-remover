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
const http = require('http');
const https = require('https');
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

    // Auto-discover cookies.txt from project dir
    const cookiesFile = options.cookiesFile || path.join(config.projectDir, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
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
 * Extract video info using Python parser.
 * Uses video_parser.py (yt-dlp + third-party API) or extract_video.py (Playwright).
 * Tries video_parser.py first, then falls back to extract_video.py.
 */
function runPythonScript(scriptPath, url) {
  return new Promise((resolve, reject) => {
    console.log(`[python] Using: ${path.basename(scriptPath)} for ${url}`);
    const proc = spawn('python', [scriptPath, url], {
      timeout: 120000,  // 2 min timeout
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(stderr.slice(0, 300) || `Python script exit ${code}`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result);
      } catch (e) {
        reject(new Error('Python extractor returned invalid JSON'));
      }
    });

    proc.on('error', err => {
      reject(new Error(`Python extractor launch failed: ${err.message}`));
    });
  });
}

async function extractWithPython(url) {
  const videoParserPath = path.join(config.projectDir, 'video_parser.py');
  const extractVideoPath = path.join(config.projectDir, 'extract_video.py');

  // Try video_parser.py first (supports yt-dlp + API providers)
  if (fs.existsSync(videoParserPath)) {
    try {
      const result = await runPythonScript(videoParserPath, url);
      console.log(`[python] video_parser.py succeeded`);
      return result;
    } catch (err) {
      console.log(`[python] video_parser.py failed: ${err.message}`);
    }
  }

  // Fallback to extract_video.py (Playwright-based)
  if (fs.existsSync(extractVideoPath)) {
    try {
      const result = await runPythonScript(extractVideoPath, url);
      console.log(`[python] extract_video.py succeeded`);
      return result;
    } catch (err) {
      console.log(`[python] extract_video.py also failed: ${err.message}`);
    }
  }

  throw new Error('所有 Python 提取器均失败');
}

/**
 * Full video info with format selection.
 * For Douyin URLs, tries yt-dlp first (with cookies), then falls back to proxy APIs.
 */
async function getVideoInfo(url, options = {}) {
  // For Douyin URLs, try yt-dlp first (with cookies) for faster parsing
  if (isDouyinUrl(url)) {
    console.log(`[ytdlp] Detected Douyin URL, trying yt-dlp first`);
    try {
      const result = await _getVideoInfoWithYtdlp(url, options);
      if (result && result.title) {
        console.log(`[ytdlp] yt-dlp info succeeded: "${result.title.slice(0, 40)}"`);
        return result;
      }
    } catch (err) {
      console.log(`[ytdlp] yt-dlp info failed, trying proxy API: ${err.message}`);
    }

    // Fallback: try proxy APIs
    console.log(`[ytdlp] Trying proxy API as fallback`);
    try {
      const proxyResult = await resolveDouyin(url);
      if (proxyResult) {
        console.log(`[ytdlp] Douyin proxy API succeeded`);
        return proxyResult;
      }
    } catch (err) {
      console.log(`[ytdlp] Douyin proxy API also failed: ${err.message}`);
    }

    throw new Error('无法解析抖音视频链接');
  }

  // Try yt-dlp for other platforms
  try {
    const result = await _getVideoInfoWithYtdlp(url, options);

    // For Xiaohongshu/Kuaishou, yt-dlp may parse metadata but not return a direct video URL.
    // Try the Python Playwright extractor as fallback to get the actual video URL.
    if (!result.directUrl && (url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn') || url.includes('kuaishou.com') || url.includes('gifshow.com'))) {
      console.log(`[ytdlp] yt-dlp got metadata but no direct URL, trying Python extractor for video URL`);
      try {
        const pyResult = await extractWithPython(url);
        if (pyResult && pyResult.video_url) {
          result.directUrl = pyResult.video_url;
          result.hasOriginal = true;
          console.log(`[ytdlp] Python extractor provided video URL`);
        }
      } catch (pyErr) {
        console.log(`[ytdlp] Python extractor also failed to get URL: ${pyErr.message}`);
      }
    }

    return result;
  } catch (ytdlpErr) {
    console.log(`[ytdlp] yt-dlp failed: ${ytdlpErr.message}`);

    // For platforms where yt-dlp fails, try Python Playwright extractor
    const needsPythonExtractor = url.includes('kuaishou.com') || url.includes('gifshow.com')
      || url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn');

    if (needsPythonExtractor) {
      console.log(`[ytdlp] Trying Python Playwright extractor as fallback`);
      try {
        const pyResult = await extractWithPython(url);
        return {
          title: (pyResult.title || 'Untitled').slice(0, 200),
          author: pyResult.author || 'Unknown',
          duration: pyResult.duration || 0,
          thumbnailUrl: pyResult.thumbnail || null,
          platform: pyResult.platform || 'unknown',
          platformLabel: pyResult.platform || 'unknown',
          videoId: '',
          webpageUrl: url,
          directUrl: pyResult.video_url || '',
          hasOriginal: !!pyResult.video_url,
        };
      } catch (pyErr) {
        console.log(`[python] Python extractor also failed: ${pyErr.message}`);
      }
    }

    // Re-throw the original yt-dlp error
    throw ytdlpErr;
  }
}

/**
 * yt-dlp based video info extraction (internal).
 */
function _getVideoInfoWithYtdlp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      '--no-playlist',
    ];

    // Use cookies file if explicitly provided or auto-discover from project dir
    const cookiesFile = options.cookiesFile || path.join(config.projectDir, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    }

    args.push(url);

    execFile(_findYtdlp(), args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const stderrStr = stderr?.toString() || '';
        const msg = stderrStr.includes('Unsupported URL')
          ? '不支持的视频链接'
          : stderrStr.includes('HTTP Error')
            ? '无法访问该视频'
            : stderrStr.includes('cookies') || stderrStr.includes('signed in')
              ? '该网站需要登录才能访问，请将浏览器导出的 cookies.txt 放到项目根目录'
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
 * Returns a Promise that resolves with { filePath: string }.
 *
 * @param {string} url - Video URL
 * @param {string} outputPath - Can be a directory (will create output.%(ext)s inside) or a file path
 * @param {object} options - { cookiesFile, progressCb }
 */
async function downloadVideo(url, outputPath, options = {}) {
  // If a direct URL is provided AND it's not a Douyin/Xiaohongshu URL, use ffmpeg
  // Douyin prefers yt-dlp for non-watermarked; Xiaohongshu CDN blocks ffmpeg
  const isXiaohongshu = url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn') || url.includes('xhslink.cn') || url.includes('xhscdn.com');
  if (options.directUrl && !isDouyinUrl(url) && !isXiaohongshu) {
    console.log(`[ytdlp] Using direct URL download: ${options.directUrl.slice(0, 80)}...`);
    let filePath = outputPath;
    if (outputPath.endsWith('.%(ext)s') || outputPath.endsWith('.mp4')) {
      filePath = outputPath.replace('.%(ext)s', '.mp4');
    } else {
      filePath = path.join(outputPath, 'output.mp4');
      fs.mkdirSync(outputPath, { recursive: true });
    }
    const result = await downloadFromUrl(options.directUrl, filePath, { ...options, sourceUrl: url });
    return result;
  }

  // Determine whether outputPath is a directory or a file path
  let finalPath;
  const isDir = fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory();
  if (isDir) {
    finalPath = path.join(outputPath, 'output.%(ext)s');
  } else if (path.extname(outputPath) === '') {
    fs.mkdirSync(outputPath, { recursive: true });
    finalPath = path.join(outputPath, 'output.%(ext)s');
  } else if (outputPath.endsWith('.%(ext)s') || outputPath.includes('%(')) {
    finalPath = outputPath;
  } else {
    finalPath = outputPath.replace(/\.(mp4|mkv|webm|m4a)$/i, '.%(ext)s');
  }

  // For Douyin URLs, try yt-dlp first (with cookies) to get non-watermarked version
  if (isDouyinUrl(url)) {
    console.log(`[ytdlp] Downloading Douyin video, trying yt-dlp first (cookies-based)`);
    try {
      const result = await _downloadWithYtdlp(url, finalPath, options);
      if (result && result.filePath) {
        console.log(`[ytdlp] yt-dlp download succeeded: ${result.filePath}`);
        return result;
      }
    } catch (err) {
      console.log(`[ytdlp] yt-dlp failed, falling back to proxy API: ${err.message}`);
    }

    // Fallback: try proxy API direct URL
    console.log(`[ytdlp] Trying proxy API as fallback for Douyin`);
    try {
      const proxyResult = await resolveDouyin(url);
      if (proxyResult && proxyResult.directUrl) {
        console.log(`[ytdlp] Downloading from proxy URL: ${proxyResult.directUrl.slice(0, 80)}...`);
        const fp = await downloadFromUrl(proxyResult.directUrl, finalPath, { ...options, sourceUrl: url });
        return { filePath: fp };
      }
    } catch (err) {
      console.log(`[ytdlp] Proxy API fallback also failed: ${err.message}`);
    }
    throw new Error('所有下载方式均失败');
  }

  // For non-Douyin URLs, try yt-dlp
  return _downloadWithYtdlp(url, finalPath, options);
}

/**
 * Get the correct Referer header for a given URL.
 */
function getRefererForUrl(url) {
  if (url.includes('bilibili.com')) return 'https://www.bilibili.com/';
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com') || url.includes('xhslink.cn') || url.includes('xhslink.cn')) return 'https://www.xiaohongshu.com/';
  if (url.includes('kuaishou.com') || url.includes('gifshow.com')) return 'https://www.kuaishou.com/';
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return 'https://www.douyin.com/';
  if (url.includes('doubao.com')) return 'https://www.doubao.com/';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'https://www.youtube.com/';
  if (url.includes('tiktok.com')) return 'https://www.tiktok.com/';
  if (url.includes('weibo.com') || url.includes('weibo.cn')) return 'https://www.weibo.com/';
  return 'https://www.douyin.com/'; // default fallback
}

/**
 * Download a video using Node.js HTTP/HTTPS (for CDNs that block ffmpeg).
 */
function downloadWithNodeJs(videoUrl, outputPath, options) {
  return new Promise((resolve, reject) => {
    const referer = getRefererForUrl(options?.sourceUrl || videoUrl);
    const mod = videoUrl.startsWith('https') ? https : http;

    console.log(`[nodejs] Downloading with Node.js: ${videoUrl.slice(0, 80)}...`);

    mod.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer,
        'Origin': 'https://www.xiaohongshu.com',
      },
      timeout: 60000,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`[nodejs] Download complete: ${outputPath} (${downloaded} bytes)`);
        resolve({ filePath: outputPath });
      });

      fileStream.on('error', (err) => {
        fs.unlinkSync(outputPath); // clean up partial file
        reject(new Error(`文件写入失败: ${err.message}`));
      });
    }).on('error', (err) => {
      reject(new Error(`下载失败: ${err.message}`));
    }).on('timeout', () => {
      reject(new Error('下载超时'));
    });
  });
}

/**
 * Download a video from a direct URL using ffmpeg.
 * Used as fallback when proxy API provides a direct video URL.
 * Returns { filePath: string }.
 */
function downloadFromUrl(videoUrl, outputPath, options) {
  const isXiaohongshu = videoUrl.includes('xhscdn.com') || videoUrl.includes('xiaohongshu.com');

  // Xiaohongshu CDN requires specific headers that ffmpeg can't send reliably
  if (isXiaohongshu) {
    return downloadWithNodeJs(videoUrl, outputPath, options);
  }

  return new Promise((resolve, reject) => {
    const referer = getRefererForUrl(options?.sourceUrl || videoUrl);
    const args = [
      '-y',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-headers', `Referer: ${referer}\r\n`,
      '-i', videoUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ filePath: outputPath });
      } else {
        // Extract meaningful error from ffmpeg output (skip version banner)
        const lines = stderr.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('Invalid') || l.includes('Connection') || l.includes('Timeout') || l.includes('404') || l.includes('403'));
        const errMsg = lines.length > 0 ? lines.join('; ').slice(0, 200) : stderr.slice(-200);
        reject(new Error(errMsg || `ffmpeg download failed with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg download failed: ${err.message}`));
    });
  });
}

/**
 * Download a video using yt-dlp (handles watermark removal for most platforms).
 * @param {string} url - Video URL
 * @param {string} outputPath - yt-dlp output template path
 * @param {object} options - { cookiesFile }
 * @returns {Promise<{filePath: string}>}
 */
function _downloadWithYtdlp(url, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
    ];

    // Force mp4 format for compatibility
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');

    // Auto-discover cookies.txt from project dir
    const cookiesFile = options.cookiesFile || path.join(config.projectDir, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    }

    // Add referer for platforms that need it
    const referer = getRefererForUrl(url);
    args.push('--add-header', `Referer:${referer}`);

    args.push(url);

    const proc = spawn(_findYtdlp(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000, // 5 min
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        // yt-dlp may output to a different extension; find the actual file
        const dir = path.dirname(outputPath);
        const baseName = path.basename(outputPath).replace('.%(ext)s', '').replace('.mp4', '');
        const actualFiles = fs.readdirSync(dir)
          .filter(f => f.startsWith(baseName) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')));
        let actualPath;
        if (actualFiles.length > 0) {
          // Pick the largest (best quality) file
          const sizes = actualFiles.map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
          sizes.sort((a, b) => b.size - a.size);
          actualPath = path.join(dir, sizes[0].name);
        } else {
          actualPath = outputPath.replace('.%(ext)s', '.mp4');
        }
        resolve({ filePath: actualPath });
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