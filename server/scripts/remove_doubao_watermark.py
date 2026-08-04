"""
去除视频中的"豆包AI生成"动态水印
使用 ffmpeg delogo 滤镜（快速，不需要逐帧处理）
水印在三个位置切换：右下角、左边中间、右上角
"""
import subprocess
import sys
import os

def remove_watermark(input_path, output_path):
    # 获取视频分辨率
    probe_cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_streams", input_path
    ]
    result = subprocess.run(probe_cmd, capture_output=True, text=True)
    import json
    info = json.loads(result.stdout)
    video_stream = next(s for s in info["streams"] if s["codec_type"] == "video")
    w = int(video_stream["width"])
    h = int(video_stream["height"])
    print(f"分辨率: {w}x{h}")

    # 三个水印位置（根据视频分辨率计算）
    # 右下角: 文字在右下角区域
    # 左边中间: 文字在左侧中间
    # 右上角: 文字在右上角
    positions = [
        # 右下角 (x, y, width, height)
        (int(w * 0.60), int(h * 0.82), int(w * 0.38), int(h * 0.16)),
        # 左边中间
        (int(w * 0.01), int(h * 0.42), int(w * 0.35), int(h * 0.16)),
        # 右上角
        (int(w * 0.60), int(h * 0.01), int(w * 0.38), int(h * 0.16)),
    ]

    # 构建 drawbox 滤镜链（用半透明黑色框覆盖水印区域）
    # 比 delogo 更彻底，速度快
    filters = []
    for x, y, bw, bh in positions:
        # 先画黑色填充框覆盖水印
        filters.append(f"drawbox=x={x}:y={y}:w={bw}:h={bh}:color=black@0.85:t=fill")

    filter_str = ",".join(filters)
    print(f"滤镜: {filter_str}")

    # 使用 ffmpeg 处理（带 re-encode）
    cmd = [
        "ffmpeg",
        "-i", input_path,
        "-vf", filter_str,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "copy",
        "-y", output_path
    ]

    print("正在处理...")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        print(f"错误: {proc.stderr[:500]}")
        return False

    print(f"完成: {output_path}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python remove_watermark.py <input.mp4> <output.mp4>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    remove_watermark(input_path, output_path)