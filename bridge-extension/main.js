// MAIN world script - runs on Kuaishou, Doubao and Douyin pages
console.log('[Bridge] MAIN world script running');

// Log ALL fetch URLs
const origFetch = window.fetch;
window.fetch = function() {
  const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0]?.url;
  if (url) console.log('[Bridge] fetch:', url.substring(0, 150));
  return origFetch.apply(this, arguments).then(async (response) => {
    if (url && (url.includes('graphql') || url.includes('photo/detail') || url.includes('get_play_info') || url.includes('get_download_info') || url.includes('samantha') || url.includes('aispace') || url.includes('aweme/detail'))) {
      try {
        const text = await response.clone().text();
        // 抖音：拦截 aweme/v1/web/aweme/detail，从 aweme_detail.video.play_addr.url_list 提取真实播放地址；
        // 图文笔记则从 images 提取图片列表（两者按任务模式分流，image 模式绝不走视频 ffmpeg 下载）。
        if (url.includes('aweme/detail')) {
          const imgs = parseDouyinAlbum(text);
          if (imgs.length) {
            console.log('[Bridge] Douyin album images found:', imgs.length);
            reportAlbumImages(imgs);
          }
          const douyinUrl = parseDouyinDetail(text);
          if (douyinUrl) {
            console.log('[Bridge] Douyin detail URL found:', douyinUrl.substring(0, 100));
            reportVideoUrl(douyinUrl);
            if (taskMode !== 'image') return response;
          }
        }
        // Check for video URL in the response (Kuaishou)
        const kuaishouMatch = text.match(/photoUrl["']?\s*[:=]\s*["']([^"']+)["']/);
        if (kuaishouMatch) {
          console.log('[Bridge] Kuaishou photoUrl found:', kuaishouMatch[1].substring(0, 100));
          reportVideoUrl(kuaishouMatch[1]);
          return response;
        }
        // Check for any video URL
        const videoUrl = text.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
        if (videoUrl) {
          console.log('[Bridge] Video URL in fetch response:', videoUrl[0].substring(0, 150));
          reportVideoUrl(videoUrl[0]);
        }
      } catch(e) {}
    }
    return response;
  });
};

// 抖音视频页判断
const isDouyinPage = location.hostname.includes('douyin.com');
// 本任务类型（background 开标签页时附加 __bridge_mode 查询参）。'video'=解析播放URL；'image'=解析图文图片列表。
// 用它在视频/图文两条上报路径间做硬分流，避免"图文+视频"混合笔记误触发对方路径。
const taskMode = new URLSearchParams(location.search).get('__bridge_mode') === 'image' ? 'image' : 'video';
console.log('[Bridge] taskMode:', taskMode);

/**
 * 抖音 URL 里常带 unicode 转义（& → &, = → =, ? → ?）。
 * CDN 签名参数靠 & 连接，若不解码还原，整个查询串会被 ffmpeg 当作一个参数，
 * 导致签名失效。此处把常见转义还原为真实字符。
 */
function decodeDouyinUrl(url) {
  if (!url) return url;
  return url
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\\//g, '/');
}

// 已上报标记：多个提取路径(fetch/XHR/video元素/performance/主动detail)可能同时命中同一视频，
// 不加去重会对同一任务重复上报，导致服务器对同一 taskId 并发多次下载、浪费带宽甚至被失效URL覆盖。
// 注意：这是"当前标签页脚本实例"级的去重。同一 taskId 若由多个标签页各自上报，仍需 background 侧按 taskId 去重。
let videoReported = false;
function reportVideoUrl(url, title) {
  if (videoReported) return;
  if (!url || !url.startsWith('http')) return;
  url = decodeDouyinUrl(String(url).replace(/\\+$/, ''));
  // 过滤装饰性/错误资源：真实抖音播放地址是 douyinvod.com 的签名 URL；带尾反斜杠、明显是静态对象、或视频ID过短的丢弃。
  if (
    !url.startsWith('http') ||
    /\\/.test(url) ||
    /obj\/eden-cn\/.*\.mp4/i.test(url) ||
    /mingxing\.mp4/i.test(url) ||
    /\.png|\.jpg|\.jpeg|\.gif|\.webp|\.ico/i.test(url)
  ) {
    console.log('[Bridge] Rejecting non-playable/bad URL:', url.substring(0, 100));
    return;
  }
  videoReported = true;
  console.log('[Bridge] Reporting video URL:', (title||'').slice(0,20), url.substring(0, 100));
  window.postMessage({ type: 'BRIDGE_VIDEO_URL', url, title: title || document.title || '' }, '*');
}

// 已上报标记：与 videoReported 同理，图文也只允许上报一次。
let albumReported = false;

/**
 * 从抖音 aweme_detail 响应里提取图文图片 URL 列表。
 * 结构: aweme_detail.images[]（或 image_infos[]），每项对象取 url_list / display_url_list / origin_url / url 首个可用 URL。
 * 与 extract_video.py 的图片提取逻辑保持一致。纯图文笔记通常没有 video.play_addr。
 */
function parseDouyinAlbum(text) {
  try {
    const data = JSON.parse(text);
    const detail = data?.aweme_detail || {};
    const imgs = detail.images || detail.image_infos || [];
    if (!Array.isArray(imgs)) return [];
    const out = [];
    for (const img of imgs) {
      if (!img || typeof img !== 'object') continue;
      let u = '';
      for (const k of ['url_list', 'display_url_list', 'origin_url', 'url']) {
        const v = img[k];
        if (Array.isArray(v) && v.length) { u = v[0]; break; }
        if (typeof v === 'string' && v) { u = v; break; }
      }
      u = decodeDouyinUrl(String(u || '').replace(/\\+$/, ''));
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  } catch (e) {}
  return [];
}

/** 上报图文图片列表（发现到图片就上报；由 background 按任务的 taskType 决定是否采用）。 */
function reportAlbumImages(images, title) {
  if (albumReported) return;
  if (!Array.isArray(images) || images.length === 0) return;
  // 只保留真实图片资源，丢弃 /video.status/ 或 blob 等非静态图片地址
  const clean = images.filter(u => /^https?:\/\//.test(u) && !/\.mp4|\.m3u8|blob:/i.test(u));
  if (clean.length === 0) return;
  albumReported = true;
  console.log('[Bridge] Reporting album images:', clean.length);
  window.postMessage({ type: 'BRIDGE_ALBUM_IMAGES', images: clean, title: title || document.title || '' }, '*');
}

/**
 * 从抖音 aweme/v1/web/aweme/detail 响应中提取真实播放地址。
 * 结构: aweme_detail.video.play_addr.url_list[0]
 * 抖音 URL 自带临时签名，直接取页面返回的 URL，不要重拼。
 */
function parseDouyinDetail(text) {
  try {
    const data = JSON.parse(text);
    const detail = data?.aweme_detail || {};
    const play = detail?.video?.play_addr || {};
    const urlList = play?.url_list || play?.url_list_v2 || [];
    // 优先选 mp4 主播放地址；若无则取第一个
    if (Array.isArray(urlList)) {
      const mp4 = urlList.find(u => typeof u === 'string' && u.includes('.mp4'));
      const hit = mp4 || (urlList[0] ? urlList[0] : null);
      if (hit) return decodeDouyinUrl(hit);
    }
  } catch (e) {}
  return null;
}

// Intercept XHR
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function() {
  const self = this;
  this.addEventListener('load', function() {
    const url = self.responseURL || '';
    if (url) console.log('[Bridge] XHR:', url.substring(0, 150));
    try {
      const text = self.responseText || '';
      // 抖音：部分版本用 XHR 拉 aweme/detail，同样解析 play_addr 与图文图片
      if (isDouyinPage && url.includes('aweme/detail')) {
        const imgs = parseDouyinAlbum(text);
        if (imgs.length) {
          console.log('[Bridge] Douyin album images from XHR detail:', imgs.length);
          reportAlbumImages(imgs);
        }
        const douyinUrl = parseDouyinDetail(text);
        if (douyinUrl) {
          console.log('[Bridge] Douyin video from XHR detail:', douyinUrl.substring(0, 120));
          reportVideoUrl(douyinUrl);
          return;
        }
      }
      const videoUrl = text.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
      if (videoUrl) {
        console.log('[Bridge] Video URL in XHR:', videoUrl[0].substring(0, 150));
        reportVideoUrl(decodeDouyinUrl(videoUrl[0]));
      }
    } catch(e) {}
  });
  origOpen.apply(this, arguments);
};

// Try to get video via get_download_info API (for user's own creations)
async function tryGetDownloadInfo() {
  try {
    // Get the video_id from the URL
    const videoId = location.href.match(/video_id=([a-zA-Z0-9]+)/)?.[1];
    if (!videoId) {
      console.log('[Bridge] No video_id in URL');
      return;
    }

    // Try get_download_info directly (might work for own creations)
    const dlResp = await fetch('/samantha/aispace/get_download_info?aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ node_id: videoId }] }),
    });
    const dlData = await dlResp.json();
    console.log('[Bridge] get_download_info response:', JSON.stringify(dlData).substring(0, 300));

    const mainUrl = dlData?.data?.download_infos?.[0]?.main_url;
    if (mainUrl) {
      console.log('[Bridge] Got download URL:', mainUrl.substring(0, 150));
      // Clean the URL
      const cleanUrl = mainUrl.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
      console.log('[Bridge] Clean download URL:', cleanUrl.substring(0, 150));
      reportVideoUrl(cleanUrl);
      return;
    }

    // If get_download_info failed, try homepage + node_info flow
    console.log('[Bridge] Trying homepage flow...');
    const homeResp = await fetch('/samantha/aispace/homepage?aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const homeData = await homeResp.json();
    console.log('[Bridge] Homepage response:', JSON.stringify(homeData).substring(0, 300));
    const creationId = homeData?.data?.children?.find(e => e.name === '我的创作')?.id;
    if (creationId) {
      console.log('[Bridge] Found creation ID:', creationId);
      const nodeResp = await fetch('/samantha/aispace/node_info?aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: creationId, need_full_path: true, size: 50, sort_param: { need_sort_config: true, sort_order: 1, sort_type: 0 } }),
      });
      const nodeData = await nodeResp.json();
      console.log('[Bridge] node_info response children count:', nodeData?.data?.children?.length || 0);
      const children = nodeData?.data?.children || [];
      children.forEach(c => console.log('[Bridge] node child:', c.name, 'key:', c.key, 'id:', c.id));
      const nodeId = children.find(e => String(e.key) === String(videoId))?.id;
      if (nodeId) {
        console.log('[Bridge] Found node ID:', nodeId);
        const dlResp2 = await fetch('/samantha/aispace/get_download_info?aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ node_id: nodeId }] }),
        });
        const dlData2 = await dlResp2.json();
        const dlInfos = dlData2?.data?.download_infos || [];
        console.log('[Bridge] download_infos count:', dlInfos.length);
        if (dlInfos.length > 0) {
          dlInfos.forEach((info, i) => {
            console.log(`[Bridge] download_infos[${i}] main_url:`, (info.main_url || '').substring(0, 200));
            console.log(`[Bridge] download_infos[${i}] lr:`, (info.main_url?.match(/lr=([^&]+)/) || [])[1] || 'none');
          });
        } else {
          console.log('[Bridge] No download_infos, full response:', JSON.stringify(dlData2).substring(0, 500));
        }
        const mainUrl2 = dlInfos?.[0]?.main_url;
        if (mainUrl2) {
          const lrMatch = mainUrl2.match(/lr=([^&]+)/);
          console.log('[Bridge] Download URL FULL:', mainUrl2);
          console.log('[Bridge] Download URL lr:', lrMatch ? lrMatch[1] : 'NOT PRESENT (good!)');
          const cleanUrl2 = mainUrl2.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
          console.log('[Bridge] Clean download URL:', cleanUrl2);
          reportVideoUrl(cleanUrl2);
        }
      }
    } else {
      console.log('[Bridge] No creation ID found, response:', JSON.stringify(homeData).substring(0, 500));
    }
  } catch(e) {
    console.log('[Bridge] get_download_info error:', e.message);
  }
}

// Check video element
function checkVideo() {
  const v = document.querySelector('video source') || document.querySelector('video');
  if (v && (v.src || v.getAttribute('src'))) {
    const src = v.src || v.getAttribute('src');
    console.log('[Bridge] Video element full src:', src);
    console.log('[Bridge] lr param:', (src.match(/lr=([^&]+)/) || [])[1] || 'NOT PRESENT');
    if (src && src.startsWith('http')) {
      const cleanUrl = src.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
      reportVideoUrl(cleanUrl);
    }
  }
}

// 尝试直接调快手 GraphQL API 获取视频 URL
async function tryKuaishouGraphQL() {
  // 从当前页面 URL 提取真实视频 ID
  const vidMatch = location.href.match(/short-video\/([a-zA-Z0-9]+)/);
  if (!vidMatch) {
    console.log('[Bridge] No real video ID in Kuaishou URL');
    return;
  }
  const photoId = vidMatch[1];
  console.log('[Bridge] Kuaishou real video ID:', photoId);

  try {
    const gql = await fetch('https://www.kuaishou.com/graphql', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Referer': location.href},
      body: JSON.stringify({
        variables: { photoId },
        query: 'query mistralVideo($photoId: String) { visionVideoDetail(photoId: $photoId) { status photo { id photoUrl coverUrl caption } } }'
      })
    });
    const data = await gql.json();
    console.log('[Bridge] Kuaishou GQL response:', JSON.stringify(data).substring(0, 300));
    const photo = data?.data?.visionVideoDetail?.photo;
    if (photo?.photoUrl) {
      console.log('[Bridge] Got Kuaishou video URL:', photo.photoUrl.substring(0, 80));
      const cleanUrl = photo.photoUrl.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
      reportVideoUrl(cleanUrl, photo.caption);
    } else {
      console.log('[Bridge] Kuaishou GQL returned no photoUrl (status:', data?.data?.visionVideoDetail?.status, ')');
    }
  } catch (e) {
    console.log('[Bridge] Kuaishou GQL error:', e.message);
  }
}

// ===== 抖音专属 =====

// 抖音：从 performance 资源记录里找真实播放地址（douyinvod.com / .mp4）
// 抖音播放 URL 常是 mime_type=video_mp4 的 vod 域名，直接取页面加载过的即可（自带签名）。
function checkDouyinPerformanceResources() {
  if (!isDouyinPage) return;
  try {
    const entries = performance.getEntriesByType('resource') || [];
    const found = [];
    for (const e of entries) {
      const u = e.name || '';
      // 过滤装饰性/背景视频（页面 UI 视频，非笔记内容）
      if (u.includes('douyin-pc-web') || u.includes('uuu_265') || u.includes('douyin_pc_client')) continue;
      if (u.includes('.mp4') || u.includes('douyinvod.com') || u.includes('playaddr')) {
        found.push(u);
      }
    }
    if (found.length > 0) {
      const url = decodeDouyinUrl(found[0]);
      console.log('[Bridge] Douyin video from performance resources:', url.substring(0, 120));
      reportVideoUrl(url);
    }
  } catch (e) {}
}

// 抖音：从 video 元素 src 提取（被动拦截失败时的兜底）
function checkDouyinVideoElement() {
  if (!isDouyinPage) return;
  const v = document.querySelector('video') || document.querySelector('video source');
  if (!v) return;
  const src = v.currentSrc || v.src || v.getAttribute('src');
  if (src && src.startsWith('http') && (src.includes('.mp4') || src.includes('douyinvod.com'))) {
    const url = decodeDouyinUrl(src);
    console.log('[Bridge] Douyin video from element:', url.substring(0, 120));
    reportVideoUrl(url);
  }
}

// 抖音：主动向当前页面的 aweme/detail API 发请求（用页面自身的 cookie/signature 上下文）
// 这是最后兜底，被动拦截应已能拿到，仅在未命中时触发。
let douyinActiveTried = false;
async function tryDouyinActiveDetail() {
  if (!isDouyinPage || douyinActiveTried) return;
  douyinActiveTried = true;
  const idMatch = location.href.match(/\/(?:video|note|share\/video)\/(\d+)/);
  if (!idMatch) {
    console.log('[Bridge] Douyin URL has no numeric video id, skipping active detail');
    return;
  }
  const awemeId = idMatch[1];
  console.log('[Bridge] Douyin active detail fetch for id:', awemeId);
  try {
    const resp = await fetch(`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}`, {
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
    });
    const text = await resp.text();
    const imgs = parseDouyinAlbum(text);
    if (imgs.length) {
      console.log('[Bridge] Douyin album images from active detail:', imgs.length);
      reportAlbumImages(imgs);
    }
    const url = parseDouyinDetail(text);
    if (url) {
      console.log('[Bridge] Douyin video from active detail:', url.substring(0, 120));
      reportVideoUrl(url);
    } else {
      console.log('[Bridge] Douyin active detail returned no playable url');
    }
  } catch (e) {
    console.log('[Bridge] Douyin active detail error:', e.message);
  }
}

// Run checks
setTimeout(checkVideo, 2000);
setTimeout(checkVideo, 5000);
setTimeout(checkVideo, 10000);

// Try Kuaishou GraphQL API after a delay
setTimeout(tryKuaishouGraphQL, 3000);

// Try get_download_info API after a delay
setTimeout(tryGetDownloadInfo, 3000);

// 抖音额外兜底（仅抖音页触发）
if (isDouyinPage) {
  setTimeout(checkDouyinVideoElement, 2000);
  setTimeout(checkDouyinVideoElement, 5000);
  setTimeout(checkDouyinPerformanceResources, 3000);
  setTimeout(checkDouyinPerformanceResources, 6000);
  setTimeout(tryDouyinActiveDetail, 4000);
}