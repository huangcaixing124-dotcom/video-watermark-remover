"""
Video Parser API Server
Self-hosted API for parsing videos from Douyin, Kuaishou, XiaoHongShu, Bilibili, etc.

Features:
- Auto-updates douyin-tiktok-scraper on startup
- Supports Bilibili via yt-dlp
- Supports other platforms via douyin-tiktok-scraper library

Usage:
    python video_api_server.py

The server runs on port 8801 and provides a simple HTTP API.
The mini program's backend calls this API to parse video URLs.
"""
import sys
import json
import os
import subprocess
import asyncio
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from douyin_tiktok_scraper.scraper import Scraper

PORT = 8801

# ─── Auto-update on startup ────────────────────────────────────
def check_and_update_scraper():
    """Check for updates to douyin-tiktok-scraper and update if available."""
    try:
        import urllib.request
        # Get current version
        result = subprocess.run(
            ['pip', 'show', 'douyin-tiktok-scraper'],
            capture_output=True, text=True, timeout=10
        )
        current_version = None
        for line in result.stdout.split('\n'):
            if line.startswith('Version:'):
                current_version = line.split(':')[1].strip()
                break

        if not current_version:
            print("[startup] Could not determine current version")
            return

        # Check latest version
        url = 'https://pypi.org/pypi/douyin-tiktok-scraper/json'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            latest_version = data['info']['version']

        if current_version != latest_version:
            print(f"[startup] Update available: {current_version} → {latest_version}")
            print("[startup] Updating...")
            result = subprocess.run(
                ['pip', 'install', '--upgrade', 'douyin-tiktok-scraper'],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0:
                print("[startup] Update successful!")
            else:
                print(f"[startup] Update failed: {result.stderr[:100]}")
        else:
            print(f"[startup] douyin-tiktok-scraper is up to date (v{current_version})")
    except Exception as e:
        print(f"[startup] Update check failed: {e}")

# Load cookies if available
COOKIES = {}
cookies_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')
if os.path.exists(cookies_file):
    with open(cookies_file, 'r', encoding='utf-8') as f:
        for line in f:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.strip().split('\t')
            if len(parts) >= 7:
                COOKIES[parts[5]] = parts[6]
    print(f"Loaded {len(COOKIES)} cookies")


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
    elif 'tiktok.com' in url:
        return 'tiktok'
    elif 'weibo.com' in url or 'weibo.cn' in url:
        return 'weibo'
    elif 'youtube.com' in url or 'youtu.be' in url:
        return 'youtube'
    return 'unknown'


async def parse_video_async(url):
    """Parse video using douyin-tiktok-scraper library."""
    platform = detect_platform(url)
    api = Scraper()

    try:
        if platform == 'bilibili':
            # Extract BV ID
            import re
            match = re.search(r'BV[\w]+', url)
            if match:
                result = await api.get_bilibili_video_data(match.group())
                if result and result.get('video_url'):
                    return {
                        'title': result.get('title', 'Bilibili Video'),
                        'video_url': result['video_url'],
                        'author': result.get('author', ''),
                        'thumbnail': result.get('thumbnail', ''),
                        'duration': result.get('duration', 0),
                        'platform': 'B站',
                    }

        elif platform == 'douyin':
            # Try to get video ID
            import re
            match = re.search(r'/video/(\d+)', url)
            if match:
                video_id = match.group()
                result = await api.get_douyin_video_data(video_id)
                if result and isinstance(result, dict):
                    # Try to extract video URL from result
                    video_url = result.get('nwm_video_url') or result.get('video_url', '')
                    if video_url:
                        return {
                            'title': result.get('desc', 'Douyin Video'),
                            'video_url': video_url,
                            'author': result.get('author', {}).get('nickname', '') if isinstance(result.get('author'), dict) else '',
                            'thumbnail': result.get('cover', ''),
                            'duration': result.get('duration', 0),
                            'platform': '抖音',
                        }

        elif platform == 'tiktok':
            import re
            match = re.search(r'/video/(\d+)', url)
            if match:
                result = await api.get_tiktok_video_data(match.group())
                if result and isinstance(result, dict):
                    video_url = result.get('nwm_video_url') or result.get('video_url', '')
                    if video_url:
                        return {
                            'title': result.get('desc', 'TikTok Video'),
                            'video_url': video_url,
                            'author': result.get('author', {}).get('unique_id', '') if isinstance(result.get('author'), dict) else '',
                            'thumbnail': result.get('cover', ''),
                            'duration': result.get('duration', 0),
                            'platform': 'TikTok',
                        }

    except Exception as e:
        print(f"Error parsing {platform}: {e}", file=sys.stderr)

    return {'error': f'无法解析{platform}视频，该平台暂不支持或需要配置API', 'platform': platform}


def parse_video(url):
    """Synchronous wrapper for async parsing."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(parse_video_async(url))
    finally:
        loop.close()


class VideoHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == '/api/parse':
            url = params.get('url', [None])[0]
            if not url:
                self.send_json({'error': '请提供 url 参数'}, 400)
                return

            result = parse_video(url)
            self.send_json(result)

        elif path == '/api/health':
            self.send_json({'status': 'ok', 'service': 'video-parser', 'version': '1.0.0'})

        elif path == '/api/platforms':
            self.send_json({
                'platforms': ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'tiktok', 'weibo', 'youtube']
            })

        elif path == '/api/update':
            # Trigger manual update check
            check_and_update_scraper()
            self.send_json({'status': 'update checked', 'timestamp': datetime.now().isoformat()})

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body) if body else {}
        except:
            self.send_json({'error': 'Invalid JSON'}, 400)
            return

        if parsed.path == '/api/parse':
            url = data.get('url')
            if not url:
                self.send_json({'error': '请提供 url 参数'}, 400)
                return

            result = parse_video(url)
            self.send_json(result)
        else:
            self.send_json({'error': 'Not found'}, 404)

    def send_json(self, data, status=200):
        response = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(response))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format, *args):
        # Suppress default logging
        pass


def main():
    # Check for updates on startup
    print("Checking for package updates...")
    check_and_update_scraper()

    server = HTTPServer(('0.0.0.0', PORT), VideoHandler)
    print(f"Video Parser API Server running on port {PORT}")
    print(f"API endpoint: http://localhost:{PORT}/api/parse?url=<video_url>")
    print(f"Health check: http://localhost:{PORT}/api/health")
    print(f"Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
        server.server_close()


if __name__ == '__main__':
    main()
