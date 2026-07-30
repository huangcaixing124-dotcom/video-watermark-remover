"""
Persistent Chromium browser service for video extraction.
Starts a headed Chromium instance that stays running in the background.
Extractors connect to it via CDP to load video pages and extract URLs.

Usage:
    # Start the browser service (run once when server starts)
    python browser_service.py start

    # Extract video URL (called by Node.js server)
    python browser_service.py extract <url>

The browser stays running between requests for fast response times.
"""
import sys
import os
import json
import time
import re
import signal
from pathlib import Path

# CDP port for the browser
CDP_PORT = 9224
PID_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.browser_service.pid')
SOCKET_FILE = f'http://127.0.0.1:{CDP_PORT}'


def is_browser_running():
    """Check if the browser service is running."""
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex(('127.0.0.1', CDP_PORT))
        sock.close()
        return result == 0
    except:
        return False


def start_browser():
    """Start the Chromium browser service."""
    if is_browser_running():
        print(f"Browser already running on port {CDP_PORT}")
        return True

    print(f"Starting Chromium browser on port {CDP_PORT}...")

    from playwright.sync_api import sync_playwright

    # Launch browser with remote debugging
    # Using headed mode to bypass anti-bot detection
    import subprocess
    import threading

    # Find Chromium path from Playwright
    playwright_path = os.path.join(
        os.path.expanduser("~"),
        "AppData", "Local", "ms-playwright",
    )

    # Find the chrome executable
    chrome_path = None
    for entry in os.listdir(playwright_path):
        if entry.startswith("chromium-"):
            chrome_dir = os.path.join(playwright_path, entry, "chrome-win64")
            if os.path.exists(chrome_dir):
                chrome_path = os.path.join(chrome_dir, "chrome.exe")
                break

    if not chrome_path:
        print("Error: Chromium not found. Run: playwright install chromium")
        return False

    # User data directory for persistent sessions
    user_data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.browser_data')
    os.makedirs(user_data_dir, exist_ok=True)

    # Start Chrome with remote debugging port
    cmd = [
        chrome_path,
        f'--remote-debugging-port={CDP_PORT}',
        f'--user-data-dir={user_data_dir}',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )

    # Save PID
    with open(PID_FILE, 'w') as f:
        f.write(str(proc.pid))

    # Wait for browser to start
    for i in range(30):
        time.sleep(1)
        if is_browser_running():
            print(f"Browser started successfully (PID: {proc.pid})")
            return True

    print("Error: Browser failed to start within 30 seconds")
    return False


def stop_browser():
    """Stop the browser service."""
    if not os.path.exists(PID_FILE):
        print("No PID file found")
        return

    with open(PID_FILE) as f:
        pid = int(f.read().strip())

    try:
        import ctypes
        ctypes.windll.kernel32.TerminateProcess(ctypes.windll.kernel32.OpenProcess(1, False, pid), 0)
        print(f"Browser stopped (PID: {pid})")
    except:
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"Browser stopped (PID: {pid})")
        except:
            print(f"Failed to stop browser (PID: {pid})")

    try:
        os.remove(PID_FILE)
    except:
        pass


def extract_video_url(url):
    """Extract video URL from a page using the running browser."""
    if not is_browser_running():
        print("Browser not running, starting...", file=sys.stderr)
        if not start_browser():
            return {'error': '无法启动浏览器服务'}

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(SOCKET_FILE)
        except Exception as e:
            print(f"Failed to connect to browser: {e}", file=sys.stderr)
            return {'error': f'无法连接浏览器: {str(e)}'}

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()

        try:
            result = _extract_from_page(page, url)
            return result
        except Exception as e:
            print(f"Extraction failed: {e}", file=sys.stderr)
            return {'error': f'提取失败: {str(e)}'}
        finally:
            page.close()


def _extract_from_page(page, url):
    """Extract video info from a page."""
    platform = _detect_platform(url)
    print(f"[extract] Platform: {platform}, URL: {url}", file=sys.stderr)

    # Navigate to the page
    page.goto(url, wait_until='domcontentloaded', timeout=30000)
    time.sleep(3)  # Wait for JavaScript to render

    if platform == 'douyin':
        return _extract_douyin(page, url)
    elif platform == 'kuaishou':
        return _extract_kuaishou(page, url)
    elif platform == 'xiaohongshu':
        return _extract_xiaohongshu(page, url)
    else:
        return {'error': f'不支持的平台: {platform}'}


def _detect_platform(url):
    """Detect platform from URL."""
    if 'douyin.com' in url or 'iesdouyin.com' in url:
        return 'douyin'
    elif 'kuaishou.com' in url or 'gifshow.com' in url:
        return 'kuaishou'
    elif 'xiaohongshu.com' in url or 'xhslink.com' in url:
        return 'xiaohongshu'
    return 'unknown'


def _extract_douyin(page, url):
    """Extract Douyin video info from the rendered page."""
    import urllib.parse

    # Method 1: Extract from RENDER_DATA
    content = page.content()
    render_match = re.search(r'<script\s+id="RENDER_DATA"\s+[^>]*>(.*?)</script>', content, re.DOTALL)
    if render_match:
        try:
            raw_data = urllib.parse.unquote(render_match.group(1))
            data = json.loads(raw_data)

            for key, value in data.items():
                if isinstance(value, dict):
                    aweme = value.get('aweme', {}).get('detail', {})
                    if not aweme:
                        aweme = value.get('awemeDetail', {})
                    if aweme:
                        video = aweme.get('video', {})
                        play_addr = video.get('play_addr', {})
                        url_list = play_addr.get('url_list', [])
                        video_url = url_list[0] if url_list else ''

                        cover = video.get('cover', {})
                        cover_url = cover.get('url_list', [''])[0] if cover else ''

                        author = aweme.get('author', {}).get('nickname', '')
                        desc = aweme.get('desc', '')
                        duration = video.get('duration', 0)

                        if video_url:
                            print(f"[douyin] Found video URL from RENDER_DATA", file=sys.stderr)
                            return {
                                'title': desc[:200] if desc else 'Untitled',
                                'author': author,
                                'video_url': video_url,
                                'duration': duration / 1000 if duration > 1000 else duration,
                                'thumbnail': cover_url,
                                'platform': '抖音',
                            }
        except Exception as e:
            print(f"[douyin] RENDER_DATA parse failed: {e}", file=sys.stderr)

    # Method 2: Extract from video element
    video_src = page.evaluate('''() => {
        const v = document.querySelector('video');
        if (v) {
            return v.src || v.currentSrc || '';
        }
        // Try source elements
        const sources = document.querySelectorAll('video source');
        for (const s of sources) {
            if (s.src) return s.src;
        }
        return '';
    }''')

    if video_src and video_src.startswith('http'):
        print(f"[douyin] Found video URL from DOM", file=sys.stderr)
        return {
            'title': page.title() or 'Untitled',
            'author': '',
            'video_url': video_src,
            'duration': 0,
            'thumbnail': '',
            'platform': '抖音',
        }

    # Method 3: Search page source for video URLs
    page_source = page.content()
    # Look for video URLs in the page source
    video_url_patterns = [
        r'"playAddr"\s*:\s*\{\s*"src"\s*:\s*"([^"]+)"',
        r'"url"\s*:\s*"(https?://[^"]*douyinvod[^"]*)"',
        r'"url"\s*:\s*"(https?://[^"]*\.mp4[^"]*)"',
    ]
    for pattern in video_url_patterns:
        match = re.search(pattern, page_source)
        if match:
            video_url = match.group(1)
            if video_url.startswith('http'):
                print(f"[douyin] Found video URL from page source", file=sys.stderr)
                return {
                    'title': page.title() or 'Untitled',
                    'author': '',
                    'video_url': video_url,
                    'duration': 0,
                    'thumbnail': '',
                    'platform': '抖音',
                }

    return {'error': '无法提取抖音视频信息，页面可能需要登录'}


def _extract_kuaishou(page, url):
    """Extract Kuaishou video info from the rendered page."""
    # Try to find video data in page
    video_src = page.evaluate('''() => {
        const v = document.querySelector('video');
        if (v) return v.src || v.currentSrc || '';
        const sources = document.querySelectorAll('video source');
        for (const s of sources) {
            if (s.src) return s.src;
        }
        return '';
    }''')

    if video_src and video_src.startswith('http'):
        return {
            'title': page.title() or 'Untitled',
            'author': '',
            'video_url': video_src,
            'duration': 0,
            'thumbnail': '',
            'platform': '快手',
        }

    # Try to find video URL in page source
    page_source = page.content()
    patterns = [
        r'"playUrl"\s*:\s*"([^"]+)"',
        r'"url"\s*:\s*"(https?://[^"]*\.mp4[^"]*)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_source)
        if match:
            video_url = match.group(1)
            if video_url.startswith('http'):
                return {
                    'title': page.title() or 'Untitled',
                    'author': '',
                    'video_url': video_url,
                    'duration': 0,
                    'thumbnail': '',
                    'platform': '快手',
                }

    return {'error': '无法提取快手视频信息'}


def _extract_xiaohongshu(page, url):
    """Extract XiaoHongShu video info from the rendered page."""
    video_src = page.evaluate('''() => {
        const v = document.querySelector('video');
        if (v) return v.src || v.currentSrc || '';
        const sources = document.querySelectorAll('video source');
        for (const s of sources) {
            if (s.src) return s.src;
        }
        return '';
    }''')

    if video_src and video_src.startswith('http'):
        return {
            'title': page.title() or 'Untitled',
            'author': '',
            'video_url': video_src,
            'duration': 0,
            'thumbnail': '',
            'platform': '小红书',
        }

    page_source = page.content()
    patterns = [
        r'"videoUrl"\s*:\s*"([^"]+)"',
        r'"url"\s*:\s*"(https?://[^"]*sns-video[^"]*)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_source)
        if match:
            video_url = match.group(1)
            if video_url.startswith('http'):
                return {
                    'title': page.title() or 'Untitled',
                    'author': '',
                    'video_url': video_url,
                    'duration': 0,
                    'thumbnail': '',
                    'platform': '小红书',
                }

    return {'error': '无法提取小红书视频信息'}


def main():
    if len(sys.argv) < 2:
        print("Usage: python browser_service.py <start|stop|extract> [url]")
        sys.exit(1)

    command = sys.argv[1]

    if command == 'start':
        success = start_browser()
        sys.exit(0 if success else 1)

    elif command == 'stop':
        stop_browser()
        sys.exit(0)

    elif command == 'extract':
        if len(sys.argv) < 3:
            print("Usage: python browser_service.py extract <url>")
            sys.exit(1)
        url = sys.argv[2]
        result = extract_video_url(url)
        print(json.dumps(result, ensure_ascii=False))

    elif command == 'status':
        running = is_browser_running()
        print(json.dumps({'running': running}))

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == '__main__':
    main()
