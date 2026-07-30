// ========== 豆包视频下载 - content.js (MAIN world) ==========
// 在 MAIN world 中运行，可以访问 window._ROUTER_DATA 等内部数据
// 负责：劫持 fetch/XHR 捕获视频信息，调用 get_play_info 接口获取无水印地址

const processedUrls = new Set();
const MAX_DEDUP_SIZE = 100;
const videoCache = new Map();

// ========== 工具：从对象中提取 main_url（尝试多种路径） ==========
function extractMainUrlFromPlayData(data) {
  if (!data || typeof data !== 'object') return null;

  // 路径 1: original_media_info.main_url
  if (data.original_media_info) {
    const om = data.original_media_info;
    if (om.main_url) return { mainUrl: om.main_url, backupUrl: om.backup_url || null, width: om.width || om.meta?.width, height: om.height || om.meta?.height, definition: om.definition || 'unknown' };
  }

  // 路径 2: play_infos 数组
  const playInfos = data.play_infos || (data.play_info ? [data.play_info] : []);
  if (playInfos.length > 0) {
    const pi = playInfos[0];
    if (pi && pi.main) {
      return {
        mainUrl: pi.main.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark'),
        backupUrl: pi.backup ? pi.backup.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark') : null,
        width: pi.width,
        height: pi.height,
        definition: pi.definition || 'unknown'
      };
    }
  }

  // 路径 3: data.main (直接对象)
  if (data.main) {
    return {
      mainUrl: data.main.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark'),
      backupUrl: data.backup ? data.backup.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark') : null,
      width: data.width,
      height: data.height,
      definition: data.definition || 'unknown'
    };
  }

  // 路径 4: media_info 数组
  if (data.media_info && Array.isArray(data.media_info)) {
    for (const mi of data.media_info) {
      const result = extractMainUrlFromPlayData(mi);
      if (result) return result;
    }
  }

  // 路径 5: video_info 对象
  if (data.video_info && data.video_info.main_url) {
    return {
      mainUrl: data.video_info.main_url,
      backupUrl: data.video_info.backup_url || null,
      width: data.video_info.width,
      height: data.video_info.height,
      definition: data.video_info.definition || 'unknown'
    };
  }

  return null;
}

// ========== 核心：调用 get_play_info 接口获取无水印视频 ==========
async function callGetPlayInfo(videoKey) {
  // 尝试多个 API 端点
  const endpoints = [
    { url: 'https://www.doubao.com/samantha/media/get_play_info', type: 'video' },
    { url: 'https://www.doubao.com/samantha/media/get_play_info', type: 'video_gen' },
    { url: 'https://www.doubao.com/creativity/video/get_play_info', type: 'video' },
  ];

  let lastError = null;
  for (const ep of endpoints) {
    try {
      const params = new URLSearchParams({
        aid: '497858',
        device_platform: 'web',
        samantha_web: '1',
        'use-olympus-account': '1',
        version_code: '20800',
        pkg_type: 'release_version',
        web_tab_id: crypto.randomUUID()
      });
      const url = `${ep.url}?${params.toString()}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'agw-js-conv': 'str',
          'origin': location.origin,
          'referer': location.href
        },
        credentials: 'include',
        body: JSON.stringify({ key: videoKey, type: ep.type })
      });

      const json = await response.json();
      if (json.code !== 0) {
        lastError = new Error(`get_play_info 返回错误: code=${json.code}, msg=${json.msg || '未知'}`);
        continue;
      }

      if (!json.data) {
        lastError = new Error('响应中无 data 字段');
        continue;
      }

      // 尝试多种路径提取视频地址
      const result = extractMainUrlFromPlayData(json.data);
      if (result && result.mainUrl) {
        return result;
      }

      // 最后尝试：直接搜索整个响应对象中的 main_url
      const found = deepFindMainUrl(json.data);
      if (found) {
        console.log('[AI去水印·豆包视频] 通过深度搜索找到 main_url');
        return { mainUrl: found, backupUrl: null, width: null, height: null, definition: 'unknown' };
      }

      lastError = new Error('无法从响应中提取视频地址');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('所有 API 端点均失败');
}

// 深度搜索对象中的 main_url
function deepFindMainUrl(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (obj.main_url && typeof obj.main_url === 'string' && obj.main_url.startsWith('http')) {
    return obj.main_url.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
  }
  if (obj.main && typeof obj.main === 'string' && obj.main.startsWith('http')) {
    return obj.main.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark');
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindMainUrl(item, depth + 1);
      if (found) return found;
    }
  } else {
    for (const key in obj) {
      if (key === 'window' || key === 'parent' || key === 'constructor') continue;
      const found = deepFindMainUrl(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ========== 从页面数据中提取视频 vid 和 messageId ==========
function safeGet(obj, path, defaultVal) {
  try {
    let cur = obj;
    const parts = path.split('.');
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return defaultVal;
      cur = cur[p];
    }
    return cur !== undefined ? cur : defaultVal;
  } catch { return defaultVal; }
}

// 搜索多种可能的 _ROUTER_DATA 路径
function searchRouterDataForVideos(routerData) {
  const results = [];
  if (!routerData) return results;

  const searchPaths = [
    'loaderData.chat_layout.trimmedChainRecentConvCells',
    'loaderData.chat_layout.convCells',
    'loaderData.chat_layout.recentConvCells',
    'loaderData.chat_layout.cells',
    'loaderData.conversation.messages',
    'loaderData.messages',
  ];

  for (const path of searchPaths) {
    try {
      const cells = safeGet(routerData, path, []);
      if (!Array.isArray(cells)) continue;

      if (path.endsWith('.messages')) {
        // 直接是 messages 数组
        for (const msg of cells) {
          const msgId = String(msg.message_id || msg.messageId || '').trim();
          if (!msgId || msgId === '0') continue;
          const msgContent = msg.content || msg;
          const vid = findVidInObject(msgContent);
          if (vid) {
            results.push({ vid, messageId: msgId });
            videoCache.set(msgId, vid);
          }
        }
      } else {
        // 是 cells 数组，每个 cell 包含 conversation
        for (const cell of cells) {
          const messages = safeGet(cell, 'conversation.messages', []);
          if (!Array.isArray(messages)) continue;
          for (const msg of messages) {
            const msgId = String(msg.message_id || msg.messageId || '').trim();
            if (!msgId || msgId === '0') continue;
            const vid = findVidInObject(msg);
            if (vid) {
              results.push({ vid, messageId: msgId });
              videoCache.set(msgId, vid);
            }
          }
        }
      }
      if (results.length > 0) break; // 找到就停止
    } catch {}
  }

  return results;
}

function findVideoAndMessageId() {
  // 1. 从 _ROUTER_DATA 搜索
  const routerData = window._ROUTER_DATA;
  if (routerData) {
    const videos = searchRouterDataForVideos(routerData);
    if (videos.length > 0) {
      console.log('[AI去水印·豆包视频] 从 _ROUTER_DATA 找到视频:', videos.length);
      return videos[0];
    }
  }

  // 2. 从 videoCache 中找最新的
  if (videoCache.size > 0) {
    const entries = Array.from(videoCache.entries());
    const last = entries[entries.length - 1];
    console.log('[AI去水印·豆包视频] 从 videoCache 取视频:', last[0]);
    return { vid: last[1], messageId: last[0] };
  }

  // 3. 尝试从页面 DOM 中提取视频元素
  try {
    const videoEls = document.querySelectorAll('video[src*="blob:"], video source[src*="blob:"]');
    if (videoEls.length > 0) {
      console.log('[AI去水印·豆包视频] 从 DOM 找到视频元素');
      // 无法从 DOM 直接获取 vid，但可以尝试找最近的 data 属性
      for (const ve of videoEls) {
        const parent = ve.closest('[data-message-id], [data-message_id]');
        if (parent) {
          const msgId = parent.dataset.messageId || parent.dataset.message_id;
          if (msgId) return { vid: 'dom_' + msgId, messageId: msgId };
        }
      }
    }
  } catch {}

  return null;
}

function findVidByMessageId(targetId) {
  // 1. 查缓存
  const cached = videoCache.get(targetId);
  if (cached) return { vid: cached, messageId: targetId };

  // 2. 从 _ROUTER_DATA 搜索
  const routerData = window._ROUTER_DATA;
  if (routerData) {
    const videos = searchRouterDataForVideos(routerData);
    for (const v of videos) {
      if (v.messageId === targetId) return v;
    }
  }

  // 3. 深度搜索兜底
  if (routerData) {
    const deepVid = deepSearchVidByMessageId(routerData, targetId);
    if (deepVid) {
      videoCache.set(targetId, deepVid);
      return { vid: deepVid, messageId: targetId };
    }
  }
  return null;
}

function deepSearchVidByMessageId(obj, targetId, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 15 || !obj || typeof obj !== 'object') return null;
  if (String(obj.message_id || obj.messageId || '').trim() === targetId) {
    const vid = findVidInObject(obj);
    if (vid) return vid;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepSearchVidByMessageId(item, targetId, depth + 1);
      if (found) return found;
    }
  } else {
    for (const key in obj) {
      if (key === 'window' || key === 'parent') continue;
      const found = deepSearchVidByMessageId(obj[key], targetId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findVidInObject(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || !obj) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findVidInObject(item, depth + 1);
      if (found) return found;
    }
  } else if (typeof obj === 'object') {
    const vid = obj.vid || obj.video_id;
    if (vid && typeof vid === 'string' && vid.startsWith('v0')) return vid;
    for (const val of Object.values(obj)) {
      const found = findVidInObject(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ========== 分享接口（旧方案回退） ==========
async function callBigmusicShareSave(messageId) {
  return new Promise(function(resolve) {
    function handler(ev) {
      if (ev.data && ev.data.type === 'bigmusicShareSaveResult') {
        window.removeEventListener('message', handler);
        resolve(ev.data.data);
      }
    }
    window.postMessage({ type: 'bigmusicShareSave', messageId: messageId }, '*');
    window.addEventListener('message', handler);
    setTimeout(function() {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 15000);
  });
}

async function callGetVideoShareInfo(shareId, vid) {
  var url = 'https://www.doubao.com/creativity/share/get_video_share_info?version_code=20800&language=zh&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=7550681679050343936&pc_version=3.14.6&region=CN&sys_region=CN&samantha_web=1&use-olympus-account=1&web_tab_id=' + crypto.randomUUID();
  try {
    var resp = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'agw-js-conv': 'str'
      },
      credentials: 'include',
      body: JSON.stringify({ share_id: shareId, vid: vid, creation_id: '' })
    });
    var json = await resp.json();
    if (json.code === 0 && json.data) return json.data;
    return null;
  } catch (e) {
    return null;
  }
}

function extractNoWatermarkVideoUrl(data) {
  var playInfo = (data && data.play_infos && data.play_infos[0]) || data.play_info || (data.main ? data : null);
  if (!playInfo || !playInfo.main) return null;
  var replaceLr = function(url) {
    if (!url) return url;
    return url.replace(/lr=video_gen_watermark_dyn/g, 'lr=video_gen_no_watermark')
              .replace(/lr=video_gen_watermark/g, 'lr=video_gen_no_watermark');
  };
  return {
    mainUrl: replaceLr(playInfo.main),
    backupUrl: replaceLr(playInfo.backup),
    width: playInfo.width,
    height: playInfo.height,
    definition: playInfo.definition
  };
}

// ========== 从 DOM 中直接提取视频链接（最后兜底） ==========
function extractVideoUrlFromDOM() {
  try {
    // 查找页面中所有 video 元素
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      // 尝试获取当前播放的 src
      const src = video.currentSrc || video.src || '';
      if (src && src.startsWith('http') && !src.startsWith('blob:')) {
        console.log('[AI去水印·豆包视频] 从 DOM video 元素找到 src:', src.substring(0, 80));
        return { mainUrl: src, backupUrl: null, width: video.videoWidth, height: video.videoHeight, definition: 'unknown', source: 'dom' };
      }
      // 尝试 source 子元素
      const sources = video.querySelectorAll('source');
      for (const source of sources) {
        const s = source.src || '';
        if (s && s.startsWith('http') && !s.startsWith('blob:')) {
          console.log('[AI去水印·豆包视频] 从 DOM source 元素找到 src:', s.substring(0, 80));
          return { mainUrl: s, backupUrl: null, width: video.videoWidth, height: video.videoHeight, definition: 'unknown', source: 'dom' };
        }
      }
    }
  } catch (e) {
    console.warn('[AI去水印·豆包视频] DOM 提取失败:', e);
  }
  return null;
}

// ========== 下载视频入口（优先新接口 get_play_info） ==========
async function startVideoDownload() {
  console.log('[AI去水印·豆包视频] startVideoDownload');
  var info = findVideoAndMessageId();
  if (!info) {
    // 最后兜底：直接从 DOM 尝试
    var domResult = extractVideoUrlFromDOM();
    if (domResult && domResult.mainUrl) {
      return { success: true, videoUrl: domResult.mainUrl, width: domResult.width, height: domResult.height, definition: domResult.definition, source: 'dom' };
    }
    return { success: false, error: '未找到视频内容' };
  }

  // 1. 优先尝试新接口 get_play_info（直接获取无水印）
  try {
    var playResult = await callGetPlayInfo(info.vid);
    if (playResult && playResult.mainUrl) {
      return {
        success: true,
        messageId: info.messageId,
        vid: info.vid,
        videoUrl: playResult.mainUrl,
        backupUrl: playResult.backupUrl,
        width: playResult.width,
        height: playResult.height,
        definition: playResult.definition,
        source: 'get_play_info'
      };
    }
  } catch (err) {
    console.warn('[AI去水印·豆包视频] 新接口失败，回退旧逻辑:', err.message);
  }

  // 2. 回退分享接口
  try {
    var share = await callBigmusicShareSave(info.messageId);
    if (!share || !share.share_id) return { success: false, error: '获取视频分享ID失败' };

    var videoData = await callGetVideoShareInfo(share.share_id, info.vid);
    if (!videoData) return { success: false, error: '获取视频信息失败', messageId: info.messageId };

    var extracted = extractNoWatermarkVideoUrl(videoData);
    if (!extracted) {
      // 尝试从 videoData 深度搜索
      var deepUrl = deepFindMainUrl(videoData);
      if (deepUrl) {
        return { success: true, messageId: info.messageId, vid: info.vid, videoUrl: deepUrl, source: 'legacy_deep' };
      }
      return { success: false, error: '提取下载链接失败', messageId: info.messageId };
    }

    return {
      success: true,
      messageId: info.messageId,
      shareId: share.share_id,
      vid: info.vid,
      videoUrl: extracted.mainUrl,
      backupUrl: extracted.backupUrl,
      width: extracted.width,
      height: extracted.height,
      definition: extracted.definition,
      source: 'legacy'
    };
  } catch (e) {
    console.warn('[AI去水印·豆包视频] 分享接口失败:', e.message);
  }

  // 3. 最后兜底：DOM 提取
  var domResult = extractVideoUrlFromDOM();
  if (domResult && domResult.mainUrl) {
    return { success: true, videoUrl: domResult.mainUrl, width: domResult.width, height: domResult.height, definition: domResult.definition, source: 'dom' };
  }

  return { success: false, error: '所有方法均失败，无法获取视频地址' };
}

async function startVideoDownloadByMessageId(messageId) {
  console.log('[AI去水印·豆包视频] startVideoDownloadByMessageId, messageId:', messageId);
  var info = findVidByMessageId(messageId);
  if (!info) return { success: false, error: '未找到视频内容', messageId: messageId };

  // 1. 优先新接口
  try {
    var playResult = await callGetPlayInfo(info.vid);
    if (playResult && playResult.mainUrl) {
      return {
        success: true,
        messageId: info.messageId,
        vid: info.vid,
        videoUrl: playResult.mainUrl,
        backupUrl: playResult.backupUrl,
        width: playResult.width,
        height: playResult.height,
        definition: playResult.definition,
        source: 'get_play_info'
      };
    }
  } catch (err) {
    console.warn('[AI去水印·豆包视频] 新接口失败，回退旧逻辑:', err.message);
  }

  // 2. 回退旧逻辑
  try {
    var share = await callBigmusicShareSave(info.messageId);
    if (!share || !share.share_id) return { success: false, error: '获取视频分享ID失败', messageId: messageId };

    var videoData = await callGetVideoShareInfo(share.share_id, info.vid);
    if (!videoData) return { success: false, error: '获取视频信息失败', messageId: messageId };

    var extracted = extractNoWatermarkVideoUrl(videoData);
    if (!extracted) {
      var deepUrl = deepFindMainUrl(videoData);
      if (deepUrl) {
        return { success: true, messageId: info.messageId, vid: info.vid, videoUrl: deepUrl, source: 'legacy_deep' };
      }
      return { success: false, error: '提取下载链接失败', messageId: messageId };
    }

    return {
      success: true,
      messageId: info.messageId,
      shareId: share.share_id,
      vid: info.vid,
      videoUrl: extracted.mainUrl,
      backupUrl: extracted.backupUrl,
      width: extracted.width,
      height: extracted.height,
      definition: extracted.definition,
      source: 'legacy'
    };
  } catch (e) {
    console.warn('[AI去水印·豆包视频] 分享接口失败:', e.message);
  }

  return { success: false, error: '所有方法均失败', messageId: messageId };
}

// ========== 劫持 fetch 和 XHR 实时捕获视频数据 ==========
function extractVideoFromMessages(messages) {
  var videos = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var msgId = String(msg.message_id || msg.messageId || '').trim();
    if (!msgId || msgId === '0') continue;
    var vid = findVidInObject(msg);
    if (vid) {
      videoCache.set(msgId, vid);
      videos.push({ vid: vid, messageId: msgId });
    }
  }
  return videos;
}

function markProcessed(url) {
  if (url) {
    processedUrls.add(url);
    if (processedUrls.size > MAX_DEDUP_SIZE) {
      var first = processedUrls.values().next().value;
      processedUrls.delete(first);
    }
  }
}

function extractAndPublishFromXHR(response, url) {
  if (url && processedUrls.has(url)) return;
  var messages = null;
  // 尝试多种路径提取 messages
  if (response && response.downlink_body && response.downlink_body.pull_singe_chain_downlink_body) {
    messages = response.downlink_body.pull_singe_chain_downlink_body.messages;
  }
  if (!messages) messages = response && response.messages ? response.messages : null;
  // 尝试其他路径
  if (!messages && response && response.data && response.data.messages) {
    messages = response.data.messages;
  }
  if (!messages) return;
  if (url) markProcessed(url);
  var videos = extractVideoFromMessages(messages);
  if (videos.length) {
    window.postMessage({ type: 'videoDataExtracted', data: videos }, '*');
  }
}

async function readSSEStream(stream) {
  var reader = stream.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  try {
    while (true) {
      var result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      var parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (var p = 0; p < parts.length; p++) {
        var match = parts[p].match(/^data: (.+)$/m);
        if (match) {
          try {
            var json = JSON.parse(match[1]);
            var patchOps = json && json.patch_op;
            // 直接节点
            var baseMsgId = String(json.message_id || json.messageId || '').trim();
            var directVid = findVidInObject(json);
            if (directVid && baseMsgId && baseMsgId !== '0') {
              videoCache.set(baseMsgId, directVid);
              window.postMessage({ type: 'videoDataExtracted', data: [{ vid: directVid, messageId: baseMsgId }] }, '*');
            }
            // 补丁列表
            if (patchOps) {
              for (var o = 0; o < patchOps.length; o++) {
                var pv = patchOps[o] && patchOps[o].patch_value;
                if (!pv) continue;
                var id = String(pv.message_id || pv.messageId || baseMsgId || '').trim();
                if (!id || id === '0') continue;
                var vid = findVidInObject(pv);
                if (vid) {
                  videoCache.set(id, vid);
                  window.postMessage({ type: 'videoDataExtracted', data: [{ vid: vid, messageId: id }] }, '*');
                }
              }
            }
          } catch(e) {}
        }
      }
    }
  } catch(e) {}
}

// ========== 劫持 window.fetch 和 XMLHttpRequest ==========
var originalFetch = window.fetch;
window.fetch = function() {
  var args = arguments;
  var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
  if (typeof url === 'string' && (
    url.indexOf('chat/completion') !== -1 ||
    url.indexOf('chat/get_message') !== -1 ||
    url.indexOf('chain/single') !== -1 ||
    url.indexOf('chat/get_history') !== -1 ||
    url.indexOf('pull_single') !== -1
  )) {
    if (processedUrls.has(url)) return originalFetch.apply(this, args);
    markProcessed(url);
    return originalFetch.apply(this, args).then(function(resp) {
      var contentType = resp.headers.get('content-type') || '';
      if (contentType.indexOf('text/event-stream') !== -1) {
        var tee = resp.body.tee();
        var newResp = new Response(tee[0], {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers
        });
        readSSEStream(tee[1]);
        return newResp;
      }
      if (contentType.indexOf('application/json') !== -1) {
        var clone = resp.clone();
        clone.json().then(function(data) { extractAndPublishFromXHR(data, url); }).catch(function() {});
      }
      return resp;
    });
  }
  return originalFetch.apply(this, args);
};

var originalXHROpen = XMLHttpRequest.prototype.open;
var originalXHRSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url) {
  this._doubaoUrl = url;
  return originalXHROpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function() {
  var self = this;
  self.addEventListener('load', function() {
    if (typeof self._doubaoUrl === 'string' && (
      self._doubaoUrl.indexOf('chain/single') !== -1 ||
      self._doubaoUrl.indexOf('chat/get_history') !== -1 ||
      self._doubaoUrl.indexOf('pull_single') !== -1 ||
      self._doubaoUrl.indexOf('chat/completion') !== -1
    )) {
      try {
        extractAndPublishFromXHR(JSON.parse(self.responseText), self._doubaoUrl);
      } catch(e) {}
    }
  });
  return originalXHRSend.apply(this, arguments);
};

// ========== 初始扫描 ==========
function scanInitialVideoData() {
  var routerData = window._ROUTER_DATA;
  if (!routerData) return;
  var videos = searchRouterDataForVideos(routerData);
  if (videos.length) {
    window.postMessage({ type: 'videoDataExtracted', data: videos }, '*');
    console.log('[AI去水印·豆包视频] 初始扫描找到视频:', videos.length);
  }
}

// ========== 消息监听 ==========
window.addEventListener('message', function(ev) {
  var msg = ev.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'startVideoDownload') {
    startVideoDownload().then(function(result) {
      window.postMessage({ type: 'videoDownloadResult', data: result }, '*');
    });
  } else if (msg.type === 'startVideoDownloadByMessageId') {
    startVideoDownloadByMessageId(msg.messageId).then(function(result) {
      window.postMessage({ type: 'videoDownloadResult', data: result }, '*');
    });
  } else if (msg.type === 'scanInitialVideos') {
    scanInitialVideoData();
  } else if (msg.type === 'diagGetCache') {
    // 诊断工具：返回 videoCache 状态
    var cacheEntries = [];
    videoCache.forEach(function(vid, msgId) {
      cacheEntries.push({ messageId: msgId, vid: vid });
    });
    window.postMessage({ type: 'diagCacheResult', data: { size: videoCache.size, entries: cacheEntries.slice(-10) } }, '*');
  }
});

// ========== 监听 SPA 路由变化 ==========
var wrapState = function(type) {
  var original = history[type];
  return function() {
    var res = original.apply(this, arguments);
    var e = new Event(type);
    e.arguments = arguments;
    window.dispatchEvent(e);
    return res;
  };
};
history.pushState = wrapState('pushState');
history.replaceState = wrapState('replaceState');

var handleRouteChange = function() {
  setTimeout(scanInitialVideoData, 500);
  setTimeout(scanInitialVideoData, 2000);
};
window.addEventListener('popstate', handleRouteChange);
window.addEventListener('pushState', handleRouteChange);
window.addEventListener('replaceState', handleRouteChange);

// ========== 初始化 ==========
setTimeout(function() { scanInitialVideoData(); }, 500);
setTimeout(function() { scanInitialVideoData(); }, 1500);

console.log('[AI去水印·豆包视频] 豆包视频下载 content script 已加载 (v1.2.1)');