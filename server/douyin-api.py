"""
简易抖音 API 服务。
用 yt-dlp 解析抖音视频链接，返回视频信息。
启动: python douyin-api.py
"""
import json
import subprocess
import sys
from pathlib import Path

# 抖音 cookies 文件路径（多平台独立 cookie 方案）。
# 优先用 server/config/douyin_cookies.txt（cookie_splitter.js 拆分产出），
# 回退到旧的共享 cookies.txt。
_COOKIES_CANDIDATES = [
    Path(__file__).parent / "config" / "douyin_cookies.txt",
    Path(__file__).parent / "cookies.txt",
]
COOKIES_FILE = next((p for p in _COOKIES_CANDIDATES if p.exists()), None)


def resolve_douyin(url: str) -> dict:
    """解析抖音视频链接，返回视频信息。"""
    args = [
        "yt-dlp",
        "--dump-json",
        "--no-download",
        "--no-warnings",
        "--no-playlist",
    ]
    if COOKIES_FILE is not None:
        args.extend(["--cookies", str(COOKIES_FILE)])
    args.append(url)

    result = subprocess.run(
        args, capture_output=True, text=True, timeout=60
    )

    if result.returncode != 0:
        raise RuntimeError(result.stderr[:500] or f"yt-dlp error: {result.returncode}")

    data = json.loads(result.stdout)

    # 提取无水印视频 URL
    direct_url = data.get("url")
    if not direct_url and data.get("formats"):
        # 选最佳视频流
        videos = [f for f in data["formats"] if f.get("vcodec") != "none" and f.get("url")]
        if videos:
            videos.sort(key=lambda f: f.get("height", 0), reverse=True)
            direct_url = videos[0]["url"]

    return {
        "title": data.get("title", ""),
        "author": data.get("uploader", data.get("channel", "Unknown")),
        "duration": data.get("duration", 0),
        "thumbnail": data.get("thumbnail", ""),
        "video_url": direct_url or "",
        "platform": "douyin",
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "请提供抖音视频链接", "usage": "python douyin-api.py <URL>"}))
        sys.exit(1)

    url = sys.argv[1]
    try:
        info = resolve_douyin(url)
        print(json.dumps(info, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()