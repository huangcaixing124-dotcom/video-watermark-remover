/**
 * Speech-to-text transcription service.
 *
 * Uses faster-whisper (Python) via child_process to:
 * - Transcribe audio files to text
 * - Generate SRT subtitles
 *
 * Workflow:
 * 1. Download video via yt-dlp (or bridge for Kuaishou)
 * 2. Extract audio via ffmpeg
 * 3. Run Whisper on audio file
 * 4. Return transcription text + SRT
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { generateId, sleep, formatDuration, getRefererForUrl } = require('../utils/helpers');
const { extractVideo: playwrightExtract } = require('./playwrightService');
const bridgeQueue = require('./bridgeQueue');
const config = require('../config');

/** Transcript task store. */
const tasks = new Map();

/** Whisper model cache dir. */
const MODEL_CACHE = path.join(config.cacheDir, 'whisper_models');
fs.mkdirSync(MODEL_CACHE, { recursive: true });

/** Transcription output dir. */
const TRANSCRIPT_DIR = path.join(config.cacheDir, 'transcripts');
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

/**
 * Create a transcription task.
 * @param {string} url - Video URL
 * @param {object} options - { language: 'zh' }
 * @returns {object} - Task info
 */
function createTask(url, options = {}) {
  const taskId = generateId();
  const taskDir = path.join(TRANSCRIPT_DIR, taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const task = {
    id: taskId,
    url,
    status: 'pending',
    progress: 0,
    text: null,
    srtPath: null,
    language: null,
    error: null,
    videoTitle: null,
    createdAt: Date.now(),
    _outputDir: taskDir,
    _audioPath: null,
  };

  tasks.set(taskId, task);

  // Start transcription in background
  (async () => {
    await runTranscription(task);
  })();

  return {
    id: taskId,
    status: task.status,
    progress: task.progress,
  };
}

/**
 * Run the full transcription pipeline.
 */
// 重试标记（在 runTranscription 中被读取）
let _retryCount = 0;

// ── Whisper 转录并发信号量 ─────────────────────────────
// 转录是 CPU 密集型。i7-14790F(16c/24t) 上同时只跑 maxTranscriptions 个，
// 其余任务排队（status='queued'），避免 CPU 被打满导致下载/API 卡顿。
let activeTranscriptions = 0;
const MAX_TRANSCRIPTIONS = config.maxTranscriptions || 3;

/**
 * 并发受控的转录入口。超过上限的任务先排队（queued），每 3s 重试一次空位。
 * 拿到空位后再执行真正的转录，确保同一时刻只有 MAX_TRANSCRIPTIONS 个在跑。
 */
async function runTranscription(task) {
  while (activeTranscriptions >= MAX_TRANSCRIPTIONS) {
    if (task.status === 'pending') task.status = 'queued';
    await sleep(3000);
  }
  if (task.status === 'queued' && !task.error) task.status = 'pending';
  activeTranscriptions++;
  try {
    await runTranscriptionBody(task);
  } finally {
    activeTranscriptions--;
  }
}

async function runTranscriptionBody(task) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      _retryCount = 0;
      // Step 1: Download video (or get audio directly for Kuaishou)
      task.status = 'downloading';
      task.progress = 5;

    const videoDir = task._outputDir;
    let videoPath = null;
    let audioPath = path.join(videoDir, 'audio.wav');

    if (task.url.includes('kuaishou.com') || task.url.includes('gifshow.com')) {
      // Kuaishou: try Playwright first, then fall back to bridge
      task.progress = 10;
      console.log(`[transcriber] Kuaishou URL detected, trying Playwright...`);

      let videoUrl = null;
      try {
        const pwResult = await playwrightExtract(task.url, { timeout: 30000 });
        if (pwResult && pwResult.videoUrl) {
          videoUrl = pwResult.videoUrl;
          console.log(`[transcriber] Playwright got Kuaishou URL: ${videoUrl.substring(0, 80)}`);
        }
      } catch (pwErr) {
        console.log(`[transcriber] Playwright failed: ${pwErr.message}, trying bridge...`);
      }

      // Playwright failed, try bridge
      if (!videoUrl) {
        console.log(`[transcriber] Adding to bridge queue: ${task.url.slice(0, 60)}...`);
        const bridgeTaskId = bridgeQueue.addTask(task.url);
        task.progress = 15;
        try {
          const bridgeResult = await bridgeQueue.waitForTask(bridgeTaskId, 180000);
          videoUrl = bridgeResult.videoUrl;
        } catch (bridgeErr) {
          throw new Error(`桥接获取视频失败: ${bridgeErr.message}`);
        }
      }

      task.progress = 30;
      // Use ffmpeg to download audio directly from the CDN URL
      // 如果 CDN URL 过期导致下载失败，重试一次（获取新 URL）
      let audioOk = false;
      for (let retry = 0; retry < 2 && !audioOk; retry++) {
        if (retry > 0) {
          // 重新获取视频 URL（旧的可能已过期）
          console.log(`[transcriber] Retrying Kuaishou audio download (attempt ${retry + 1})...`);
          try {
            const pwResult = await playwrightExtract(task.url, { timeout: 30000 });
            if (pwResult && pwResult.videoUrl) {
              videoUrl = pwResult.videoUrl;
            }
          } catch {}
        }
        try {
          await downloadAudioFromUrl(videoUrl, audioPath, task.url);
          // 验证音频文件是否有效
          if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1024) {
            audioOk = true;
          } else {
            console.warn(`[transcriber] Audio file too small or missing, retrying...`);
          }
        } catch (dlErr) {
          console.warn(`[transcriber] Audio download failed: ${dlErr.message}`);
          if (retry === 1) throw dlErr;
        }
      }
    } else {
      // Standard flow: download full video via yt-dlp
      await downloadVideoWithYTDL(task.url, videoDir);

      // Find downloaded audio
      const files = fs.readdirSync(videoDir);
      const audioFile = files.find(f => f.endsWith('.m4a') || f.endsWith('.webm') || f.endsWith('.wav') || f.endsWith('.mp3'));
      if (!audioFile) {
        // 如果没找到音频文件，尝试找视频文件（兜底）
        const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv'));
        if (videoFile) {
          videoPath = path.join(videoDir, videoFile);
        } else {
          task.status = 'failed';
          task.error = '下载音频失败';
          return;
        }
      } else {
        videoPath = path.join(videoDir, audioFile);
      }

      // Step 2: Extract audio from video
      task.status = 'extracting';
      task.progress = 20;

      task._audioPath = audioPath;
      await extractAudio(videoPath, audioPath);
    }

    // Step 3: Transcribe
    task.status = 'transcribing';
    task.progress = 40;

    // 先用 zh 强制中文识别（快、对普通话准）。
    // 若识别结果为空，很可能是语言误判（英文/粤语/多语言/BGM干扰），
    // 自动用 auto 语言检测再试一次，避免"明明有对白却返回空文案"。
    let text = await runWhisper(audioPath, task._outputDir, config.whisperModelSize, 'zh', config.whisperDevice, config.whisperComputeType);
    let lang = 'zh';
    if (!text || !text.trim()) {
      console.log(`[transcriber] zh transcription empty (${audioPath}), retrying with auto language detection...`);
      try {
        text = await runWhisper(audioPath, task._outputDir, config.whisperModelSize, 'auto', config.whisperDevice, config.whisperComputeType);
        lang = 'auto';
        console.log(`[transcriber] auto language retry done, text_len=${(text || '').trim().length}`);
      } catch (e) {
        console.warn(`[transcriber] auto language retry failed: ${e.message}`);
      }
    }

    task.text = text;
    task.language = lang;
    task.progress = 90;

    // Find SRT
    const srtPath = path.join(task._outputDir, 'output.srt');
    if (fs.existsSync(srtPath)) {
      task.srtPath = srtPath;
    }

    task.status = 'completed';
    task.progress = 100;

    // Cleanup video file (keep audio + transcript)
    try { if (videoPath) fs.unlinkSync(videoPath); } catch {}
    return; // 成功，退出
  } catch (err) {
    const msg = err.message || '';
    const isRetryable = isRetryableError(err) || msg.includes('timeout') || msg.includes('timed out');

    if (attempt < 2 && isRetryable) {
      const delay = attempt * 5000;
      console.log(`[transcriber] Retry (${attempt}/2) after ${delay}ms: ${msg.slice(0, 100)}`);
      task.status = 'downloading';
      task.progress = 5;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    task.status = 'failed';
    task.error = friendlyError(msg);
    task.progress = 0;
    return;
  }
  }
}

/** 将原始错误信息转为用户友好的提示 */
function friendlyError(err) {
  const msg = (err || '').toLowerCase();
  if (msg.includes('ssl') || msg.includes('eof') || msg.includes('connection reset') || msg.includes('connection refused') || msg.includes('timed out')) {
    return '网络波动导致下载失败，请重试。如果持续失败，请检查网络连接后重试。';
  }
  if (msg.includes('403') || msg.includes('forbidden')) {
    return '视频源拒绝访问，可能是链接已失效或需更新 cookies。';
  }
  if (msg.includes('404') || msg.includes('not found')) {
    return '视频文件不存在，请检查链接是否正确。';
  }
  if (msg.includes('private') || msg.includes('private video')) {
    return '该视频为私密视频，无法访问。';
  }
  if (msg.includes('no video formats') || msg.includes('unsupported url')) {
    return '不支持的视频链接，请检查链接是否正确。';
  }
  if (msg.includes('cookies') || msg.includes('signed in') || msg.includes('login')) {
    return '该平台需要登录，请更新 cookies.txt 后重试。';
  }
  // 截取前 200 字符
  return (err || '').slice(0, 200);
}

/** 判断错误是否为 SSL/网络波动问题（可重试） */
function isRetryableError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('ssl') || msg.includes('unexpected_eof') || msg.includes('eof occurred')
    || msg.includes('connection reset') || msg.includes('connection refused');
}

/**
 * Download video via yt-dlp，带 SSL 网络波动自动重试。
 */
function downloadVideoWithYTDL(url, outputDir) {
  return new Promise((resolve, reject) => {
    const attempt = (triesLeft) => {
      const args = [
        '--no-playlist',
        '--no-warnings',
        '-f', 'bestaudio[ext=m4a]/bestaudio/best', // 只下载音频，不下载视频
        '-o', path.join(outputDir, 'audio.%(ext)s'),
      ];

      // Check cookies
      const cookiesFile = path.join(config.projectDir, 'cookies.txt');
      if (fs.existsSync(cookiesFile)) {
        args.push('--cookies', cookiesFile);
      }

      args.push(url);

      const proc = spawn('yt-dlp', args, {
        timeout: 0, // 不限时
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';

      proc.stderr.on('data', data => { stderr += data.toString(); });

      proc.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          const err = new Error(stderr.slice(0, 300) || `yt-dlp exit ${code}`);
          if (triesLeft > 0 && isRetryableError(err)) {
            const delay = (2 - triesLeft + 1) * 1000;
            console.log(`[transcriber] yt-dlp retry (${triesLeft} left) after ${delay}ms: ${err.message}`);
            setTimeout(() => attempt(triesLeft - 1), delay);
          } else {
            reject(err);
          }
        }
      });

      proc.on('error', (e) => {
        if (triesLeft > 0 && isRetryableError(e)) {
          setTimeout(() => attempt(triesLeft - 1), 1000);
        } else {
          reject(e);
        }
      });
    };

    attempt(3); // 最多 3 次重试（共 4 次尝试），间隔递增 3s/6s/9s
  });
}

/**
 * Extract audio from video using ffmpeg.
 */
function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      audioPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code === 0) resolve(audioPath);
      else reject(new Error(stderr.slice(0, 300)));
    });

    proc.on('error', reject);
  });
}

/**
 * Download audio directly from a video URL using ffmpeg.
 * Used for Kuaishou videos where we have the CDN URL but no local file.
 * Skips full video download — extracts audio directly.
 */
function downloadAudioFromUrl(videoUrl, audioPath, sourceUrl) {
  return new Promise((resolve, reject) => {
    const referer = getRefererForUrl(sourceUrl || videoUrl);
    const args = [
      '-y',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-headers', `Referer: ${referer}\r\n`,
      '-i', videoUrl,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      audioPath,
    ];
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 0, // 不限时，等下载自然完成
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve(audioPath);
      } else {
        const lines = stderr.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('Invalid') || l.includes('403') || l.includes('404'));
        const errMsg = lines.length > 0 ? lines.join('; ').slice(0, 200) : stderr.slice(-200);
        reject(new Error(errMsg || `ffmpeg audio download failed with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Run Whisper transcription.
 */
function runWhisper(audioPath, outputDir, modelSize, language, device, computeType) {
  return new Promise((resolve, reject) => {
    // Use the external Python script to avoid inline script encoding issues
    const scriptPath = path.join(__dirname, 'whisper_transcribe.py');

    const proc = spawn('python', [
      scriptPath,
      audioPath,
      outputDir,
      modelSize,
      language,
      device,
      computeType,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 0 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.slice(0, 2000) || `Whisper exit ${code}`));
        return;
      }

      // Read the output text file
      const textPath = path.join(outputDir, 'output.txt');
      if (fs.existsSync(textPath)) {
        resolve(fs.readFileSync(textPath, 'utf-8').trim());
      } else {
        reject(new Error('Whisper completed but no output file found'));
      }
    });

    proc.on('error', reject);
  });
}

/** Get task status. */
function getTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    text: task.text,
    srtPath: task.srtPath ? path.relative(TRANSCRIPT_DIR, task.srtPath) : null,
    language: task.language,
    error: task.error,
    createdAt: task.createdAt,
  };
}

/** Get raw transcript text. */
function getTranscriptText(taskId) {
  const task = tasks.get(taskId);
  return task ? task.text : null;
}

/** Get SRT file path. */
function getSrtPath(taskId) {
  const task = tasks.get(taskId);
  return task?.srtPath || null;
}

/** Cleanup old completed tasks. */
function cleanup() {
  const now = Date.now();
  const ttlMs = config.completedTaskTTLSeconds * 1000;

  for (const [id, task] of tasks) {
    if ((task.status === 'completed' || task.status === 'failed') && now - task.createdAt > ttlMs) {
      const dir = task._outputDir;
      if (dir && fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const f of files) fs.unlinkSync(path.join(dir, f));
          fs.rmdirSync(dir);
        } catch {}
      }
      tasks.delete(id);
    }
  }
}

/** Start periodic cleanup. */
function startCleanup() {
  setInterval(cleanup, config.taskCleanupIntervalSeconds * 1000);
}

module.exports = { createTask, getTask, getTranscriptText, getSrtPath, startCleanup };