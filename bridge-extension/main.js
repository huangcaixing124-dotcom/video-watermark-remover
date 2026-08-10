// MAIN world script - runs on Kuaishou and Doubao pages
console.log('[Bridge] MAIN world script running');

// Log ALL fetch URLs
const origFetch = window.fetch;
window.fetch = function() {
  const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0]?.url;
  if (url) console.log('[Bridge] fetch:', url.substring(0, 150));
  return origFetch.apply(this, arguments).then(async (response) => {
    if (url && (url.includes('graphql') || url.includes('photo/detail') || url.includes('get_play_info') || url.includes('get_download_info') || url.includes('samantha') || url.includes('aispace'))) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        // Check for video URL in the response (Kuaishou)
        const kuaishouMatch = text.match(/photoUrl["']?\s*[:=]\s*["']([^"']+)["']/);
        if (kuaishouMatch) {
          console.log('[Bridge] Kuaishou photoUrl found:', kuaishouMatch[1].substring(0, 100));
          window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: kuaishouMatch[1], title: document.title || '' }, '*');
          return response;
        }
        // Check for any video URL
        const videoUrl = text.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
        if (videoUrl) {
          console.log('[Bridge] Video URL in fetch response:', videoUrl[0].substring(0, 150));
          window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: videoUrl[0], title: document.title || '' }, '*');
        }
      } catch(e) {}
    }
    return response;
  });
};

// Intercept XHR
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function() {
  const self = this;
  this.addEventListener('load', function() {
    const url = self.responseURL || '';
    if (url) console.log('[Bridge] XHR:', url.substring(0, 150));
    try {
      const text = self.responseText || '';
      const videoUrl = text.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
      if (videoUrl) {
        console.log('[Bridge] Video URL in XHR:', videoUrl[0].substring(0, 150));
        window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: videoUrl[0], title: document.title || '' }, '*');
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
      window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: cleanUrl, title: document.title || '' }, '*');
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
          window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: cleanUrl2, title: document.title || '' }, '*');
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
      window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: cleanUrl, title: document.title || '' }, '*');
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
      window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: cleanUrl, title: photo.caption || document.title || '' }, '*');
    } else {
      console.log('[Bridge] Kuaishou GQL returned no photoUrl (status:', data?.data?.visionVideoDetail?.status, ')');
    }
  } catch (e) {
    console.log('[Bridge] Kuaishou GQL error:', e.message);
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