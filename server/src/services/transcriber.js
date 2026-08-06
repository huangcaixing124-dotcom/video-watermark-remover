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
async function runTranscription(task) {
  try {
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
      await downloadAudioFromUrl(videoUrl, audioPath, task.url);
    } else {
      // Standard flow: download full video via yt-dlp
      await downloadVideoWithYTDL(task.url, videoDir);

      // Find downloaded video
      const files = fs.readdirSync(videoDir);
      const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'));
      if (!videoFile) {
        task.status = 'failed';
        task.error = '下载视频失败';
        return;
      }
      videoPath = path.join(videoDir, videoFile);

      // Step 2: Extract audio from video
      task.status = 'extracting';
      task.progress = 20;

      task._audioPath = audioPath;
      await extractAudio(videoPath, audioPath);
    }

    // Step 3: Transcribe
    task.status = 'transcribing';
    task.progress = 40;

    const text = await runWhisper(audioPath, task._outputDir, config.whisperModelSize, 'zh', config.whisperDevice, config.whisperComputeType);

    task.text = text;
    task.language = 'zh';
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
  } catch (err) {
    task.status = 'failed';
    task.error = err.message.slice(0, 500);
    task.progress = 0;
  }
}

/**
 * Download video via yt-dlp.
 */
function downloadVideoWithYTDL(url, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--merge-output-format', 'mp4',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-o', path.join(outputDir, 'video.%(ext)s'),
    ];

    // Check cookies
    const cookiesFile = path.join(config.projectDir, 'cookies.txt');
    if (fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    }

    args.push(url);

    const proc = spawn('yt-dlp', args, {
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';

    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.slice(0, 300) || `yt-dlp exit ${code}`));
      }
    });

    proc.on('error', reject);
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
      timeout: 300000,
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
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.slice(0, 500) || `Whisper exit ${code}`));
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