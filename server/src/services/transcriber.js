/**
 * Speech-to-text transcription service.
 *
 * Uses faster-whisper (Python) via child_process to:
 * - Transcribe audio files to text
 * - Generate SRT subtitles
 *
 * Workflow:
 * 1. Download video via yt-dlp
 * 2. Extract audio via ffmpeg
 * 3. Run Whisper on audio file
 * 4. Return transcription text + SRT
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { generateId, sleep, formatDuration } = require('../utils/helpers');
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
 * Python script for Whisper transcription.
 * Uses faster-whisper library to transcribe audio to SRT.
 */
const WHISPER_SCRIPT = `
import sys
import os
from pathlib import Path
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
output_dir = sys.argv[2]
model_size = sys.argv[3]
language = sys.argv[4]
device = sys.argv[5]
compute_type = sys.argv[6]

# On Windows, use direct model path to avoid symlink issues with HF cache
# Try to find the cached model snapshot first
hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
model_dir = hf_cache / f"models--Systran--faster-whisper-{model_size}"
if model_dir.exists():
    snapshots = list((model_dir / "snapshots").iterdir()) if (model_dir / "snapshots").exists() else []
    if snapshots:
        model_path = str(snapshots[0])
        print(f"Using cached model at {model_path}")
    else:
        model_path = model_size
        print(f"Using model: {model_size}")
else:
    model_path = model_size
    print(f"Using model: {model_size}")

print(f"Loading model...")
model = WhisperModel(
    model_path,
    device=device,
    compute_type=compute_type,
    cache_dir=Path(output_dir).parent
)

print("Transcribing...")
segments, info = model.transcribe(
    audio_path,
    language=language,
    beam_size=5,
    vad_filter=True,
    vad_parameters={
        "threshold": 0.3,
        "min_silence_duration_ms": 500,
    },
)

# Generate SRT
srt_path = Path(output_dir) / "output.srt"
srt_lines = []
i = 1
for seg in segments:
    start = seg.start
    end = seg.end
    text = seg.text.strip()
    if not text:
        continue
    def fmt_ts(t):
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        ms = int((t % 1) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    srt_lines.append(f"{i}")
    srt_lines.append(f"{fmt_ts(start)} --> {fmt_ts(end)}")
    srt_lines.append(text)
    srt_lines.append("")
    i += 1

srt_path.write_text("\\n".join(srt_lines), encoding="utf-8")

# Generate plain text
text_path = Path(output_dir) / "output.txt"
text_path.write_text("\\n".join(s for s in srt_lines if not s.endswith("-->") and s.strip() and not s.isdigit()), encoding="utf-8")

print(f"Transcription complete. Language: {info.language} ({info.language_probability:.1%})")
`;

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
    // Step 1: Download video
    task.status = 'downloading';
    task.progress = 5;
    await sleep(200);

    const videoDir = task._outputDir;
    const outputPath = path.join(videoDir, 'video.%(ext)s');

    await downloadVideoWithYTDL(task.url, videoDir);

    // Find downloaded video
    const files = fs.readdirSync(videoDir);
    const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'));
    if (!videoFile) {
      task.status = 'failed';
      task.error = '下载视频失败';
      return;
    }
    const videoPath = path.join(videoDir, videoFile);

    // Step 2: Extract audio
    task.status = 'extracting';
    task.progress = 20;
    await sleep(200);

    const audioPath = path.join(videoDir, 'audio.wav');
    task._audioPath = audioPath;
    await extractAudio(videoPath, audioPath);

    // Step 3: Transcribe
    task.status = 'transcribing';
    task.progress = 40;
    await sleep(200);

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
    try { fs.unlinkSync(videoPath); } catch {}
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
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

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
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

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