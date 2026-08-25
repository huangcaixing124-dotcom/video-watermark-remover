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
    elif 'xiaohongshu.com' in url or 'xhslink.com' in url or 'xhslink.cn' in url:
        return 'xiaohongshu'
    elif 'weibo.com' in url or 'weibo.cn' in url:
        return 'weibo'
    return 'unknown'


def extract_douyin(page, url):
    """Extract video info from Douyin page (supports video AND image notes)."""
    import urllib.parse
    print(f"[douyin] Navigating to {url}", file=sys.stderr)

    # Extract video ID from URL (support /video/ and /note/)
    video_id = ''
    match = re.search(r'/(?:video|note)/(\d+)', url)
    if match:
        video_id = match.group(1)
    else:
        # Try to resolve short URL
        page.goto(url, wait_until='domcontentloaded', timeout=30000)
        time.sleep(2)
        current_url = page.url
        match = re.search(r'/(?:video|note)/(\d+)', current_url)
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
                    # Also extract images if present (Douyin image note)
                    images = []
                    image_infos = detail.get('image_infos', []) or detail.get('images', [])
                    for img in image_infos:
                        if isinstance(img, dict):
                            # Try different image URL formats
                            img_url = ''
                            for key in ['url_list', 'display_url_list', 'origin_url', 'url']:
                                vals = img.get(key, [])
                                if isinstance(vals, list) and vals:
                                    img_url = vals[0]
                                    break
                                elif isinstance(vals, str) and vals:
                                    img_url = vals
                                    break
                            if img_url and img_url not in images:
                                images.append(img_url)

                    content_type = 'mixed' if images and video_url else 'video'
                    return {
                        'title': desc[:200] if desc else 'Untitled',
                        'author': author,
                        'content_type': content_type,
                        'images': images,
                        'image_count': len(images),
                        'description': desc,
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

            images_found = []
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

                        # 图文笔记：提取图片列表
                        img_post = aweme.get('image_post_info', {})
                        img_infos = img_post.get('images', [])
                        for img in img_infos:
                            disp = img.get('display_image', {})
                            ul = disp.get('url_list', [])
                            if ul:
                                images_found.append(ul[0])
                            # 原图（更高清）
                            if not ul:
                                orig = img.get('origin_image', {})
                                ol = orig.get('url_list', [])
                                if ol:
                                    images_found.append(ol[0])

                        content_type = 'mixed' if images_found and video_url else ('image_set' if images_found else 'video')
                        return {
                            'title': desc[:200] if desc else 'Untitled',
                            'author': author,
                            'content_type': content_type,
                            'images': images_found,
                            'image_count': len(images_found),
                            'description': desc,
                            'video_url': video_url,
                            'duration': duration / 1000 if duration > 1000 else duration,
                            'thumbnail': cover_url or (images_found[0] if images_found else ''),
                            'platform': '抖音',
                        }
    except Exception as e:
        print(f"[douyin] Page extraction failed: {e}", file=sys.stderr)

    # Method 3: Network interception (only for video notes, skip if /note/ image post)
    if '/note/' not in page.url:
        try:
            video_urls = []
            def handle_response(response):
                u = response.url
                # 过滤装饰性/背景视频（页面 UI 的视频，非笔记内容）
                if 'douyin-pc-web' in u or 'uuu_265' in u or 'douyin_pc_client' in u:
                    return
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

    # 如果已经识别为 /note/，直接跳到图文 DOM 提取
    if '/note/' in page.url:
        pass  # 继续执行 Method 4

    # Method 4: 图文笔记 — 从页面 DOM 提取真实笔记图片（过滤静态资源）
    try:
        # 先导航到图片完整加载的页面
        if '/video/' not in page.url and '/note/' not in page.url:
            page.goto(url, wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(5000)

        images = page.evaluate("""
            () => {
                const set = new Set();
                document.querySelectorAll('img').forEach(img => {
                    if (img.src && img.src.includes('douyinpic.com')) {
                        const s = img.src;
                        // 过滤掉图标/静态资源
                        if (s.includes('aweme-client-static') || s.includes('im-resource') || s.includes('logo') || s.includes('icon')) return;
                        // 去掉尺寸参数和签名后缀，保留原始图地址
                        const base = s.split('~tplv-')[0];
                        const cleaned = base.split('?')[0];
                        if (cleaned.startsWith('http')) set.add(cleaned);
                    }
                });
                return Array.from(set);
            }
        """)

        if images:
            # 用第一个图作为封面
            return {
                'title': page.title() or '抖音图文',
                'author': '',
                'content_type': 'image_set',
                'images': images,
                'image_count': len(images),
                'description': page.title() or '',
                'video_url': '',
                'duration': 0,
                'thumbnail': images[0],
                'platform': '抖音',
            }
    except Exception as e:
        print(f"[douyin] Image note extraction failed: {e}", file=sys.stderr)

    return {'error': '无法提取抖音视频信息，请检查链接是否正确'}


def extract_kuaishou(page, url):
    """Extract video info from Kuaishou page."""
    print(f"[kuaishou] Navigating to {url}", file=sys.stderr)
    page.goto(url, wait_until='domcontentloaded', timeout=30000)
    time.sleep(3)

    # Method 1: Extract from __APOLLO_STATE__ or window data
    try:
        data = page.evaluate("""
            () => {
                try {
                    // Kuaishou uses various data sources
                    if (window.__APOLLO_STATE__) return JSON.stringify(window.__APOLLO_STATE__);
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
                        if (text.includes('playUrl') || text.includes('videoUrl')) {
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

            # Try to extract from Apollo state
            if not video_url and isinstance(parsed, dict):
                for key, value in parsed.items():
                    if isinstance(value, dict):
                        play_url = value.get('playUrl') or value.get('videoUrl') or value.get('photo', {}).get('playUrl', '')
                        if play_url and play_url.startswith('http'):
                            video_url = play_url
                            break

            if video_url:
                return {
                    'title': page.title() or 'Untitled',
                    'author': '',
                    'video_url': video_url,
                    'duration': 0,
                    'thumbnail': '',
                    'platform': '快手',
                }
    except Exception as e:
        print(f"[kuaishou] JS extraction failed: {e}", file=sys.stderr)

    # Method 2: Network interception
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
    """Extract note info from XiaoHongShu page (supports both video and image notes)."""
    import urllib.parse
    print(f"[xiaohongshu] Navigating to {url}", file=sys.stderr)
    page.goto(url, wait_until='domcontentloaded', timeout=30000)
    time.sleep(3)

    # Method 1: Extract from __INITIAL_STATE__ or __NEXT_DATA__ (precise)
    try:
        data = page.evaluate("""
            () => {
                try {
                    if (window.__INITIAL_STATE__) return JSON.stringify(window.__INITIAL_STATE__);
                    if (window.__NEXT_DATA__) return JSON.stringify(window.__NEXT_DATA__);
                    return null;
                } catch(e) { return null; }
            }
        """)
        if data:
            parsed = json.loads(data)
            note = None
            images = []
            desc = ''
            author = ''

            # Try __INITIAL_STATE__.note.noteDetailMap
            note_map = parsed.get('note', {}).get('noteDetailMap', {})
            for note_id, note_info in note_map.items():
                n = note_info.get('note', {})
                if n:
                    note = n
                    break

            # Try __INITIAL_STATE__.note.noteDetail
            if not note:
                note = parsed.get('note', {}).get('noteDetail', {})

            # Try __NEXT_DATA__.props.pageProps.note
            if not note:
                try:
                    note = parsed['props']['pageProps']['note']
                except:
                    pass

            if note:
                desc = note.get('desc', '') or note.get('title', '') or ''
                author = note.get('user', {}).get('nickname', '') or note.get('author', '') or ''

                # Extract images from image_list
                image_list = note.get('image_list', []) or note.get('images', []) or note.get('imageList', [])
                if image_list:
                    for img in image_list:
                        if isinstance(img, dict):
                            url = img.get('url', '') or img.get('original', '') or img.get('info_list', [{}])[0].get('image_url', '') or ''
                            if url:
                                # Xiaohongshu stores image URLs with format: https://ci.xiaohongshu.com/xxx
                                # Sometimes it's a relative path or needs scheme
                                if url.startswith('//'):
                                    url = 'https:' + url
                                images.append(url)
                        elif isinstance(img, str):
                            if img.startswith('//'):
                                img = 'https:' + img
                            images.append(img)

                # Also try image_list in image_list format (another common path)
                if not images:
                    for img in note.get('image_list', []):
                        if isinstance(img, dict):
                            info = img.get('info_list', [{}])[0] if img.get('info_list') else img
                            url = info.get('image_url', '') or img.get('url', '')
                            if url:
                                if url.startswith('//'):
                                    url = 'https:' + url
                                images.append(url)

                # Extract video URL if present
                video = note.get('video', {}) or {}
                video_url = ''
                if video:
                    media = video.get('media', []) or []
                    if media and isinstance(media, list):
                        video_url = media[0].get('url', '') or ''
                    elif isinstance(media, dict):
                        video_url = media.get('url', '') or ''
                    if not video_url:
                        video_url = video.get('url', '') or video.get('videoUrl', '') or ''

                if images or video_url:
                    result = {
                        'title': desc[:200] if desc else 'Untitled',
                        'author': author,
                        'content_type': 'image_set' if images and not video_url else ('mixed' if images and video_url else 'video'),
                        'images': images,
                        'image_count': len(images),
                        'description': desc,
                        'video_url': video_url,
                        'duration': 0,
                        'thumbnail': images[0] if images else '',
                        'platform': '小红书',
                    }
                    print(f"[xiaohongshu] Extracted {len(images)} images, video={bool(video_url)}, desc={desc[:50]}", file=sys.stderr)
                    return result

    except Exception as e:
        print(f"[xiaohongshu] JS extraction failed: {e}", file=sys.stderr)

    # Method 2: Try to find video (fallback bridge-extension style)
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
                'content_type': 'video',
                'images': [],
                'image_count': 0,
                'description': '',
                'video_url': video_urls[0],
                'duration': 0,
                'thumbnail': '',
                'platform': '小红书',
            }
    except Exception as e:
        print(f"[xiaohongshu] Network interception failed: {e}", file=sys.stderr)

    return {'error': '无法提取小红书笔记信息，请检查链接是否正确'}


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
            args=['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
        )

        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
        )

        # 对需要防检测的平台注入脚本绕过 headless 识别（抖音等）
        # (实际注入在 page 创建后执行)

        # Load cookies if available — 抖音图文若带 cookies 会触发风控拿不到图片，故抖音跳过
        if platform == 'douyin':
            print("[main] Skipping cookies for douyin (avoids captcha block)", file=sys.stderr)
        elif os.path.exists(cookies_file):
            try:
                # 平台对应的 cookie 域名关键词
                platform_cookie_domains = {
                    'kuaishou': ['kuaishou.com', 'gifshow.com'],
                    'xiaohongshu': ['xiaohongshu.com', 'xhscdn.com'],
                    'weibo': ['weibo.com'],
                }
                keep_domains = platform_cookie_domains.get(platform)
                cookies = []
                with open(cookies_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith('#HttpOnly_'):
                            line = line[len('#HttpOnly_'):]
                        if not line or line.startswith('#'):
                            continue
                        parts = line.split('\t')
                        if len(parts) < 7:
                            continue
                        raw_domain = parts[0]
                        domain = raw_domain.lstrip('.')
                        # 只保留当前平台域的 cookie
                        if keep_domains and not any(domain.endswith(d) or d.endswith(domain) for d in keep_domains):
                            continue
                        cookies.append({
                            'name': parts[5],
                            'value': parts[6],
                            'domain': raw_domain,
                            'path': parts[2],
                            'secure': parts[3] == 'TRUE',
                            'httpOnly': False,
                        })
                if cookies:
                    context.add_cookies(cookies)
                    print(f"[main] Loaded {len(cookies)} {platform} cookies", file=sys.stderr)
            except Exception as e:
                print(f"[main] Failed to load cookies: {e}", file=sys.stderr)

        page = context.new_page()

        # 绕过 headless 检测（抖音等平台），提升图文/视频提取稳定性
        if platform == 'douyin':
            page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (p) => p.name === 'notifications' ? Promise.resolve({ state: 'denied' }) : originalQuery(p);
            """)
            print("[main] Injected headless-bypass script for douyin", file=sys.stderr)

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
