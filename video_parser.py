"""
Multi-platform video parser with pluggable API providers.
Supports: Douyin, Kuaishou, XiaoHongShu, Bilibili, Weibo

Configure your API provider in api_config.json:
{
    "provider": "custom",
    "api_url": "https://your-api.com/parse?url={url}",
    "field_mapping": {
        "title": "data.title",
        "video_url": "data.play_url",
        "author": "data.author",
        "thumbnail": "data.cover"
    }
}
"""
import sys
import json
import os
import re
import subprocess
from pathlib import Path

# ─── Configuration ──────────────────────────────────────────────
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'api_config.json')

# Default field mappings for common API response formats
PROVIDER_PRESETS = {
    'vvhan': {
        'api_url': 'https://api.vvhan.com/api/douyin?url={url}',
        'field_mapping': {
            'title': 'data.title',
            'video_url': 'data.url',
            'author': 'data.author',
            'thumbnail': 'data.cover',
        },
    },
    'oioweb': {
        'api_url': 'https://api.oioweb.cn/api/common/ShortVideo?url={url}',
        'field_mapping': {
            'title': 'data.title',
            'video_url': 'data.url',
            'author': 'data.author',
            'thumbnail': 'data.cover',
        },
    },
    'juhe': {
        'api_url': 'http://v.juhe.cn/txn/short?url={url}&key=YOUR_KEY',
        'field_mapping': {
            'title': 'result.title',
            'video_url': 'result.url',
            'author': 'result.author',
            'thumbnail': 'result.cover',
        },
    },
    'custom': {
        'api_url': '',
        'field_mapping': {
            'title': 'title',
            'video_url': 'video_url',
            'author': 'author',
            'thumbnail': 'thumbnail',
        },
    },
}

# ─── Helpers ────────────────────────────────────────────────────

def detect_platform(url):
    """Detect video platform from URL."""
    if 'douyin.com' in url or 'iesdouyin.com' in url:
        return 'douyin'
    elif 'kuaishou.com' in url or 'gifshow.com' in url:
        return 'kuaishou'
    elif 'xiaohongshu.com' in url or 'xhslink.com' in url:
        return 'xiaohongshu'
    elif 'bilibili.com' in url:
        return 'bilibili'
    elif 'weibo.com' in url or 'weibo.cn' in url:
        return 'weibo'
    elif 'tiktok.com' in url:
        return 'tiktok'
    elif 'youtube.com' in url or 'youtu.be' in url:
        return 'youtube'
    return 'unknown'


def get_nested_value(obj, path):
    """Get value from nested dict using dot notation. e.g., 'data.title'"""
    keys = path.split('.')
    for key in keys:
        if isinstance(obj, dict) and key in obj:
            obj = obj[key]
        else:
            return None
    return obj


def load_config():
    """Load API configuration."""
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


# ─── yt-dlp fallback ────────────────────────────────────────────

def parse_with_ytdlp(url, platform):
    """Parse video using yt-dlp (works for Bilibili, YouTube, etc.)."""
    if platform not in ('bilibili', 'youtube', 'weibo', 'tiktok'):
        return None

    # Find yt-dlp binary
    import shutil
    ytdlp_cmd = shutil.which('yt-dlp')
    if not ytdlp_cmd:
        # Try common locations
        home = os.path.expanduser('~')
        candidates = [
            os.path.join(home, '.venv', 'Scripts', 'yt-dlp.exe'),
            'F:/OpenMontage/.venv/Scripts/yt-dlp.exe',
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                ytdlp_cmd = candidate
                break

    if not ytdlp_cmd:
        print("[parser] yt-dlp not found", file=sys.stderr)
        return None

    try:
        cookies_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')
        args = [ytdlp_cmd, '--dump-json', '--no-download', '--no-playlist']
        if os.path.exists(cookies_file):
            args.extend(['--cookies', cookies_file])
        args.append(url)

        result = subprocess.run(args, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            data = json.loads(result.stdout)

            # Get video URL - check top-level url first, then formats
            video_url = data.get('url', '')
            if not video_url and 'formats' in data:
                # Pick best format (highest quality with url)
                best = None
                for fmt in data['formats']:
                    if fmt.get('url') and fmt.get('vcodec') != 'none':
                        if not best or (fmt.get('height', 0) or 0) > (best.get('height', 0) or 0):
                            best = fmt
                if best:
                    video_url = best['url']

            return {
                'title': data.get('title', 'Untitled'),
                'video_url': video_url,
                'author': data.get('uploader', data.get('channel', '')),
                'thumbnail': data.get('thumbnail', ''),
                'duration': data.get('duration', 0),
                'platform': platform,
            }
        else:
            print(f"[parser] yt-dlp failed: {result.stderr[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[parser] yt-dlp error: {e}", file=sys.stderr)
    return None


# ─── API Provider ───────────────────────────────────────────────

def parse_with_api(url, config):
    """Parse video using configured API provider."""
    import requests

    api_url = config['api_url'].replace('{url}', url)
    field_map = config.get('field_mapping', PROVIDER_PRESETS['custom']['field_mapping'])

    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
        }

        resp = requests.get(api_url, headers=headers, timeout=15)
        if resp.status_code != 200:
            return None

        data = resp.json()

        # Extract fields using mapping
        result = {}
        for field, path in field_map.items():
            result[field] = get_nested_value(data, path)

        # Check if we got valid data
        if result.get('video_url'):
            result['platform'] = detect_platform(url)
            return result

    except Exception:
        pass
    return None


# ─── Main Parser ────────────────────────────────────────────────

def parse_with_local_api(url):
    """Parse video using local video_api_server.py."""
    import requests

    try:
        resp = requests.get(
            f'http://localhost:8801/api/parse',
            params={'url': url},
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get('video_url'):
                return data
            if data.get('error'):
                print(f"[parser] Local API error: {data['error']}", file=sys.stderr)
    except Exception as e:
        print(f"[parser] Local API not available: {e}", file=sys.stderr)
    return None


# ─── Main Parser ────────────────────────────────────────────────

def parse_video(url):
    """
    Parse video from any supported platform.
    Tries: yt-dlp (for supported platforms) → Local API → Configured API → error.

    Returns: {title, video_url, author, thumbnail, platform, duration} or {error}
    """
    platform = detect_platform(url)
    print(f"[parser] Platform: {platform}, URL: {url}", file=sys.stderr)

    # Step 1: Try yt-dlp for supported platforms
    if platform in ('bilibili', 'youtube', 'weibo', 'tiktok'):
        result = parse_with_ytdlp(url, platform)
        if result and result.get('video_url'):
            print(f"[parser] yt-dlp succeeded", file=sys.stderr)
            return result

    # Step 2: Try local API server (video_api_server.py on port 8801)
    print(f"[parser] Trying local API server...", file=sys.stderr)
    result = parse_with_local_api(url)
    if result:
        print(f"[parser] Local API succeeded", file=sys.stderr)
        return result

    # Step 3: Try configured API provider
    config = load_config()
    if config and config.get('api_url'):
        print(f"[parser] Trying API provider: {config.get('provider', 'custom')}", file=sys.stderr)
        result = parse_with_api(url, config)
        if result:
            print(f"[parser] API provider succeeded", file=sys.stderr)
            return result

    # Step 4: No method worked
    return {
        'error': f'无法解析{platform}视频，请检查链接或确保视频解析API服务已启动',
        'platform': platform,
    }


# ─── CLI ────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python video_parser.py <url>")
        print("\nConfigure API provider in api_config.json")
        sys.exit(1)

    url = sys.argv[1]
    result = parse_video(url)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
