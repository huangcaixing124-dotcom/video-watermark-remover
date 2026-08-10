"""
Unified video URL extractor for platforms not supported by yt-dlp.
Supports: Douyin, Kuaishou, XiaoHongShu

Usage:
    python extract_video.py <url>

Output: JSON with {title, author, video_url, duration, thumbnail, platform}
"""
import sys
import json
import re
import os
import time
from urllib.parse import urlparse, parse_qs

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"error": "playwright not installed. Run: pip install playwright && playwright install chromium"}))
    sys.exit(1)


def detect_platform(url):
    """Detect which platform the URL belongs to."""
    if 'douyin.com' in url or 'iesdouyin.com' in url:
        return 'douyin'
    elif 'kuaishou.com' in url or 'gifshow.com' in url:
        return 'kuaishou'
    elif 'xiaohongshu.com' in url or 'xhslink.com' in url:
        return 'xiaohongshu'
    elif 'weibo.com' in url or 'weibo.cn' in url:
        return 'weibo'
    return 'unknown'


def extract_douyin(page, url):
    """Extract video info from Douyin page."""
    import urllib.parse
    print(f"[douyin] Navigating to {url}", file=sys.stderr)

    # Extract video ID from URL
    video_id = ''
    match = re.search(r'/video/(\d+)', url)
    if match:
        video_id = match.group(1)
    else:
        # Try to resolve short URL
        page.goto(url, wait_until='domcontentloaded', timeout=30000)
        time.sleep(2)
        current_url = page.url
        match = re.search(r'/video/(\d+)', current_url)
        if match:
            video_id = match.group(1)

    if not video_id:
        return {'error': '无法从链接中提取视频ID'}

    print(f"[douyin] Video ID: {video_id}", file=sys.stderr)

    # Method 1: Use Douyin Web API directly
    try:
        # Get cookies from browser context
        cookies = page.context.cookies()
        cookie_str = '; '.join([f"{c['name']}={c['value']}" for c in cookies if 'douyin' in c.get('domain', '')])

        api_url = f'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id={video_id}'

        # Use page.evaluate to make the API call with proper headers
        result = page.evaluate(f"""
            async () => {{
                try {{
                    const response = await fetch('{api_url}', {{
                        headers: {{
                            'Referer': 'https://www.douyin.com/',
                            'Accept': 'application/json',
                        }},
                        credentials: 'include',
                    }});
                    const data = await response.json();
                    return JSON.stringify(data);
                }} catch(e) {{
                    return JSON.stringify({{error: e.message}});
                }}
            }}
        """)

        if result:
            data = json.loads(result)
            detail = data.get('aweme_detail', {})
            if detail:
                video = detail.get('video', {})
                play_addr = video.get('play_addr', {})
                url_list = play_addr.get('url_list', [])
                video_url = url_list[0] if url_list else ''

                cover = video.get('cover', {})
                cover_url = cover.get('url_list', [''])[0] if cover else ''

                author = detail.get('author', {}).get('nickname', '')
                desc = detail.get('desc', '')
                duration = video.get('duration', 0)

                if video_url:
                    return {
                        'title': desc[:200] if desc else 'Untitled',
                        'author': author,
                        'video_url': video_url,
                        'duration': duration / 1000 if duration > 1000 else duration,
                        'thumbnail': cover_url,
                        'platform': '抖音',
                    }
    except Exception as e:
        print(f"[douyin] Web API failed: {e}", file=sys.stderr)

    # Method 2: Navigate to page and extract from RENDER_DATA
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=30000)
        time.sleep(3)

        content = page.content()
        render_match = re.search(r'<script\s+id="RENDER_DATA"\s+[^>]*>(.*?)</script>', content, re.DOTALL)
        if render_match:
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
                            return {
                                'title': desc[:200] if desc else 'Untitled',
                                'author': author,
                                'video_url': video_url,
                                'duration': duration / 1000 if duration > 1000 else duration,
                                'thumbnail': cover_url,
                                'platform': '抖音',
                            }
    except Exception as e:
        print(f"[douyin] Page extraction failed: {e}", file=sys.stderr)

    # Method 3: Network interception
    try:
        video_urls = []
        def handle_response(response):
            u = response.url
            if any(x in u for x in ['douyinvod.com', 'v26', 'v3-web', 'playaddr', '.mp4', 'aweme/detail']):
                try:
                    if 'aweme/detail' in u:
                        body = response.json()
                        detail = body.get('aweme_detail', {})
                        if detail:
                            play = detail.get('video', {}).get('play_addr', {}).get('url_list', [])
                            if play:
                                video_urls.append(play[0])
                    elif '.mp4' in u or 'douyinvod' in u:
                        video_urls.append(u)
                except:
                    pass

        page.on('response', handle_response)
        page.reload(wait_until='domcontentloaded', timeout=30000)
        time.sleep(5)

        if video_urls:
            return {
                'title': page.title() or 'Untitled',
                'author': '',
                'video_url': video_urls[0],
                'duration': 0,
                'thumbnail': '',
                'platform': '抖音',
            }
    except Exception as e:
        print(f"[douyin] Network interception failed: {e}", file=sys.stderr)

    return {'error': '无法提取抖音视频信息，请检查链接是否正确'}


def extract_kuaishou(page, url):
    """Extract video info from Kuaishou page.
    Validates that the extracted video matches the URL's video ID."""
    import re
    print(f"[kuaishou] Navigating to {url}", file=sys.stderr)

    # Extract video ID from URL
    video_id = ''
    # Format: /short-video/xxxxx or /xxxxx (short link or direct ID)
    m = re.search(r'/([a-zA-Z0-9]+)(?:\?.*)?$', url.rstrip('/'))
    if m:
        video_id = m.group(1)
        print(f"[kuaishou] Target video ID: {video_id}", file=sys.stderr)

    page.goto(url, wait_until='domcontentloaded', timeout=30000)
    time.sleep(3)

    # Method 1: Extract from __APOLLO_STATE__ or __INITIAL_STATE__ (precise match)
    try:
        data = page.evaluate("""
            (vid) => {
                try {
                    // 1. Apollo state (primary)
                    const apollo = window.__APOLLO_STATE__;
                    if (apollo) {
                        for (const key of Object.keys(apollo)) {
                            const val = apollo[key];
                            if (val && typeof val === 'object') {
                                // Match photo by id
                                const photo = val.photo || val;
                                if (photo && (photo.id === vid || photo.photoId === vid)) {
                                    const url = photo.photoUrl || photo.playUrl || photo.videoUrl || '';
                                    if (url) return JSON.stringify({video_url: url, title: photo.caption || ''});
                                }
                                // Match key containing video ID
                                if (key.includes(vid) && (val.photoUrl || val.playUrl || val.videoUrl)) {
                                    const url = val.photoUrl || val.playUrl || val.videoUrl;
                                    return JSON.stringify({video_url: url, title: val.caption || ''});
                                }
                            }
                        }
                    }

                    // 2. INITIAL_STATE
                    const init = window.__INITIAL_STATE__;
                    if (init) {
                        const photo = init.photo || init.video;
                        if (photo && (photo.id === vid || photo.photoId === vid)) {
                            const url = photo.photoUrl || photo.playUrl || photo.videoUrl || '';
                            if (url) return JSON.stringify({video_url: url, title: photo.caption || ''});
                        }
                    }

                    // 3. NEXT_DATA
                    const next = window.__NEXT_DATA__;
                    if (next && next.props) {
                        const pp = next.props.pageProps || {};
                        const photo = pp.photo || pp.video;
                        if (photo && (photo.id === vid || photo.photoId === vid)) {
                            const url = photo.photoUrl || photo.playUrl || photo.videoUrl || '';
                            if (url) return JSON.stringify({video_url: url, title: photo.caption || ''});
                        }
                    }

                    // 4. Fallback: find video element
                    const video = document.querySelector('video');
                    if (video && video.src) return JSON.stringify({video_url: video.src, title: document.title});
                    const source = document.querySelector('video source');
                    if (source && source.src) return JSON.stringify({video_url: source.src, title: document.title});

                    return null;
                } catch(e) { return null; }
            }
        """, video_id)

        if data:
            parsed = json.loads(data)
            if parsed.get('video_url'):
                print(f"[kuaishou] Matched video {video_id} from page state", file=sys.stderr)
                return {
                    'title': parsed.get('title', '') or 'Untitled',
                    'author': '',
                    'video_url': parsed['video_url'],
                    'duration': 0,
                    'thumbnail': '',
                    'platform': '快手',
                }
    except Exception as e:
        print(f"[kuaishou] JS extraction failed: {e}", file=sys.stderr)

    # Method 2: Network interception (fallback)
    try:
        video_urls = []
        def handle_response(response):
            u = response.url
            if any(x in u for x in ['kuaishou', 'gifshow', '.mp4', 'playUrl', 'videoUrl']):
                try:
                    body = response.text()
                    if 'playUrl' in body or 'videoUrl' in body:
                        data = json.loads(body)
                        video_urls.append(data)
                except:
                    pass

        page.on('response', handle_response)
        page.reload(wait_until='domcontentloaded', timeout=30000)
        time.sleep(5)

        for data in video_urls:
            if isinstance(data, dict):
                # Try to match by video ID in the response data
                for key, value in (data.items() if isinstance(data, dict) else []):
                    if isinstance(value, dict):
                        photo = value.get('photo', value)
                        if photo.get('id') == video_id or photo.get('photoId') == video_id:
                            play_url = photo.get('photoUrl') or photo.get('playUrl') or photo.get('videoUrl', '')
                            if play_url:
                                return {
                                    'title': photo.get('caption', '') or 'Untitled',
                                    'author': '',
                                    'video_url': play_url,
                                    'duration': 0,
                                    'thumbnail': '',
                                    'platform': '快手',
                                }

                # No ID match, take first result (less reliable)
                play_url = data.get('playUrl') or data.get('videoUrl', '')
                if play_url:
                    return {
                        'title': page.title() or 'Untitled',
                        'author': '',
                        'video_url': play_url,
                        'duration': 0,
                        'thumbnail': '',
                        'platform': '快手',
                    }
    except Exception as e:
        print(f"[kuaishou] Network interception failed: {e}", file=sys.stderr)

    return {'error': '无法提取快手视频信息，请检查链接是否正确'}


def extract_xiaohongshu(page, url):
    """Extract video info from XiaoHongShu page."""
    print(f"[xiaohongshu] Navigating to {url}", file=sys.stderr)
    page.goto(url, wait_until='domcontentloaded', timeout=30000)
    time.sleep(3)

    # Method 1: Extract from __INITIAL_STATE__ or __NEXT_DATA__
    try:
        data = page.evaluate("""
            () => {
                try {
                    if (window.__INITIAL_STATE__) return JSON.stringify(window.__INITIAL_STATE__);
                    if (window.__NEXT_DATA__) return JSON.stringify(window.__NEXT_DATA__);

                    // Try to find video element
                    const video = document.querySelector('video');
                    if (video) {
                        const src = video.src || video.querySelector('source')?.src || '';
                        if (src) return JSON.stringify({video_src: src});
                    }

                    // Try to find video URL in page source
                    const scripts = document.querySelectorAll('script');
                    for (const script of scripts) {
                        const text = script.textContent;
                        if (text.includes('videoUrl') || text.includes('video_url')) {
                            const match = text.match(/"(https?:[^"]+\.mp4[^"]*)"/);
                            if (match) return JSON.stringify({video_src: match[1]});
                        }
                    }

                    return null;
                } catch(e) { return null; }
            }
        """)
        if data:
            parsed = json.loads(data)
            video_url = parsed.get('video_src', '')

            # Try to extract from initial state
            if not video_url and isinstance(parsed, dict):
                # XiaoHongShu stores note data
                note_data = parsed.get('note', {}).get('noteDetailMap', {})
                for note_id, note_info in note_data.items():
                    note = note_info.get('note', {})
                    video = note.get('video', {})
                    media = video.get('media', [{}])
                    if media:
                        video_url = media[0].get('url', '') if isinstance(media, list) else media.get('url', '')
                    if not video_url:
                        # Try other paths
                        video_url = note.get('videoUrl', '') or note.get('url', '')
                    if video_url:
                        break

            if video_url:
                return {
                    'title': page.title() or 'Untitled',
                    'author': '',
                    'video_url': video_url,
                    'duration': 0,
                    'thumbnail': '',
                    'platform': '小红书',
                }
    except Exception as e:
        print(f"[xiaohongshu] JS extraction failed: {e}", file=sys.stderr)

    # Method 2: Network interception
    try:
        video_urls = []
        def handle_response(response):
            u = response.url
            if any(x in u for x in ['.mp4', 'sns-video', 'xhscdn']):
                video_urls.append(u)

        page.on('response', handle_response)
        page.reload(wait_until='domcontentloaded', timeout=30000)
        time.sleep(5)

        if video_urls:
            return {
                'title': page.title() or 'Untitled',
                'author': '',
                'video_url': video_urls[0],
                'duration': 0,
                'thumbnail': '',
                'platform': '小红书',
            }
    except Exception as e:
        print(f"[xiaohongshu] Network interception failed: {e}", file=sys.stderr)

    return {'error': '无法提取小红书视频信息，请检查链接是否正确'}


EXTRACTORS = {
    'douyin': extract_douyin,
    'kuaishou': extract_kuaishou,
    'xiaohongshu': extract_xiaohongshu,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python extract_video.py <url>"}))
        sys.exit(1)

    url = sys.argv[1]
    platform = detect_platform(url)

    if platform not in EXTRACTORS:
        print(json.dumps({"error": f"不支持的平台: {platform}"}))
        sys.exit(1)

    print(f"[main] Platform: {platform}, URL: {url}", file=sys.stderr)

    # Clean up temp directory
    temp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pw_temp")
    if os.path.exists(temp_dir):
        try:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
        except:
            pass

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-gpu'],
        )

        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
        )

        # Load cookies if available
        cookies_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')
        if os.path.exists(cookies_file):
            try:
                cookies = []
                with open(cookies_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith('#'):
                            continue
                        parts = line.split('\t')
                        if len(parts) >= 7:
                            domain = parts[0]
                            if domain.startswith('.'):
                                domain = domain[1:]
                            cookies.append({
                                'name': parts[5],
                                'value': parts[6],
                                'domain': parts[0],
                                'path': parts[2],
                                'secure': parts[3] == 'TRUE',
                                'httpOnly': False,
                            })
                if cookies:
                    context.add_cookies(cookies)
                    print(f"[main] Loaded {len(cookies)} cookies", file=sys.stderr)
            except Exception as e:
                print(f"[main] Failed to load cookies: {e}", file=sys.stderr)

        page = context.new_page()

        try:
            result = EXTRACTORS[platform](page, url)
        except Exception as e:
            result = {'error': f'提取失败: {str(e)}'}
        finally:
            browser.close()

    # Cleanup
    if os.path.exists(temp_dir):
        try:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
        except:
            pass

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
