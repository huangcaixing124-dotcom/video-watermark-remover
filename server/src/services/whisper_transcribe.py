"""
Whisper transcription script.
Called by Node.js server for video text extraction.
"""
import sys
import os
from pathlib import Path

def main():
    if len(sys.argv) < 7:
        print("Usage: python whisper_transcribe.py <audio> <output_dir> <model> <lang> <device> <compute>")
        sys.exit(1)

    audio_path = sys.argv[1]
    output_dir = sys.argv[2]
    model_size = sys.argv[3]
    language = sys.argv[4]
    device = sys.argv[5]
    compute_type = sys.argv[6]

    from faster_whisper import WhisperModel

    # On Windows, use direct model path to avoid symlink issues with HF cache
    hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
    model_dir = hf_cache / f"models--Systran--faster-whisper-{model_size}"

    model_path = model_size  # Default: use model name
    if model_dir.exists():
        snapshots_dir = model_dir / "snapshots"
        if snapshots_dir.exists():
            snapshots = list(snapshots_dir.iterdir())
            if snapshots:
                model_path = str(snapshots[0])
                print(f"Using cached model at {model_path}")

    print(f"Loading model...")
    model = WhisperModel(
        model_path,
        device=device,
        compute_type=compute_type,
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

    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")

    # Generate plain text
    text_path = Path(output_dir) / "output.txt"
    text_lines = [s for s in srt_lines if not s.endswith("-->") and s.strip() and not s.isdigit()]
    text_path.write_text("\n".join(text_lines), encoding="utf-8")

    print(f"Transcription complete. Language: {info.language} ({info.language_probability:.1%})")


if __name__ == "__main__":
    main()
