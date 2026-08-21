"""
Whisper transcription script.
Called by Node.js server for video text extraction.
"""
import sys
import os
import traceback
from pathlib import Path


def main():
    if len(sys.argv) < 7:
        print("Usage: python whisper_transcribe.py <audio> <output_dir> <model> <lang> <device> <compute>")
        sys.exit(1)

    audio_path = sys.argv[1]
    output_dir = sys.argv[2]
    model_size = sys.argv[3]
    language = sys.argv[4] if sys.argv[4] != 'auto' else None
    device = sys.argv[5]
    compute_type = sys.argv[6]

    # Try to load zhconv for traditional→simplified Chinese conversion
    t2s_conv = None
    try:
        from zhconv import convert
        t2s_conv = lambda t: convert(t, 'zh-cn')
        print("zhconv loaded for simplified Chinese conversion")
    except ImportError:
        pass

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
    try:
        segments, info = model.transcribe(
            audio_path,
            language=language,
            beam_size=3,
            vad_filter=True,
            vad_parameters={
                "threshold": 0.5,
                "min_silence_duration_ms": 500,
            },
        )

        # 一次性收集所有 segment（合并时才需要整体遍历）
        collected = []
        for seg in segments:
            start = seg.start
            end = seg.end
            text = seg.text.strip()
            if not text:
                continue
            if t2s_conv:
                text = t2s_conv(text)
            collected.append({'start': start, 'end': end, 'text': text})

        # ── 生成 SRT（保留原始分段）────────────────────
        srt_path = Path(output_dir) / "output.srt"
        srt_lines = []
        def fmt_ts(t):
            h = int(t // 3600)
            m = int((t % 3600) // 60)
            s = int(t % 60)
            ms = int((t % 1) * 1000)
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        for idx, seg in enumerate(collected, start=1):
            srt_lines.append(f"{idx}")
            srt_lines.append(f"{fmt_ts(seg['start'])} --> {fmt_ts(seg['end'])}")
            srt_lines.append(seg['text'])
            srt_lines.append("")
        srt_path.write_text("\n".join(srt_lines), encoding="utf-8")

        # ── 生成纯文本（智能合并被 Whisper 拆散的短句）──
        merged = _merge_sentences(collected)
        text_path = Path(output_dir) / "output.txt"
        text_path.write_text("\n".join(merged), encoding="utf-8")

        detected_lang = info.language or 'unknown'
        print(f"Transcription complete. Language: {detected_lang} ({info.language_probability:.1%}) segments={len(collected)} merged_lines={len(merged)}")

    except Exception as e:
        error_msg = f"Whisper transcription failed: {e}\n{traceback.format_exc()}"
        print(error_msg, file=sys.stderr)
        sys.exit(1)


# ── 标点与合并工具 ──────────────────────────────────
_SENT_END = ('。', '？', '！')  # 中文句末标点
_SENT_END_EN = ('.', '?', '!')       # 英文句末标点

def _ends_sentence(text):
    """判断文本是否以句子结束标点结尾。"""
    text = text.rstrip()
    if not text:
        return False
    last = text[-1]
    if last in _SENT_END or last in _SENT_END_EN:
        return True
    return False

def _is_english(text):
    """粗略判断是否为英文为主（合并时用英文句号）。"""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    en = sum(1 for c in letters if ord(c) < 128)
    return en / len(letters) > 0.5

def _merge_sentences(segs, max_gap=0.5):
    """把 Whisper 按静音拆分、语义不完整的短句合并成完整句子。

    规则：
    1. 当前 buffer 已以句末标点结尾 → 断开（这是一个完整句子）
    2. 否则 → 与下一段合并（累积成逻辑连贯的一句话）
    3. 两段间隔 > max_gap 秒（明显停顿）→ 即使未到句末标点也强制断开，
       防止把两个独立短句糊在一起
    """
    lines = []
    if not segs:
        return lines

    buffer = segs[0]['text']
    buffer_end = segs[0]['end']

    for i in range(1, len(segs)):
        seg = segs[i]
        gap = seg['start'] - buffer_end

        # buffer 已是完整句子（句末标点结尾）→ 断开
        if _ends_sentence(buffer):
            lines.append(buffer)
            buffer = seg['text']
            buffer_end = seg['end']
            continue

        # 间隔明显（停顿 > max_gap）→ 断开，上下文不太连贯
        if gap > max_gap:
            lines.append(buffer)
            buffer = seg['text']
            buffer_end = seg['end']
            continue

        # 语义连贯 → 合并
        if _is_english(buffer + seg['text']):
            buffer = buffer.rstrip() + ' ' + seg['text'].lstrip()
        else:
            buffer = buffer.rstrip() + seg['text']
        buffer_end = seg['end']

    if buffer:
        lines.append(buffer)

    return [l.strip() for l in lines if l.strip()]


if __name__ == "__main__":
    main()
