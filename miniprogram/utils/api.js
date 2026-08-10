/**
 * API 调用封装
 */
const app = getApp();

/** 实际发起一次 wx.request，返回 Promise */
function _rawRequest(apiBase, method, url, data, isGet) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiBase}${url}`,
      method,
      data: isGet ? data : JSON.stringify(data),
      dataType: 'json',
      header: isGet ? {} : { 'Content-Type': 'application/json' },
      timeout: 120000,
      success: (res) => {
        if (res.statusCode === 200) resolve(res.data);
        else reject(new Error(res.data?.error || `HTTP ${res.statusCode}`));
      },
      fail: () => reject(new Error('网络请求失败，请检查服务器地址')),
    });
  });
}

/**
 * 带故障转移的请求：
 * 1. 用当前服务器地址请求
 * 2. 网络失败时，重新探测主/备服务器
 * 3. 若探测到不同地址，自动切换并重试一次
 */
function request(method, url, data = {}) {
  const apiBase = app.globalData.apiBase || 'https://api.hcxserver.xyz';
  const isGet = method === 'GET';

  return _rawRequest(apiBase, method, url, data, isGet).catch((err) => {
    // 网络层失败（超时/断网）才触发故障转移；HTTP 错误不切换
    if (err.message !== '网络请求失败，请检查服务器地址') throw err;

    // 重新探测主备服务器
    return app.resolveServer().then(({ ok, url: newBase }) => {
      if (!ok || newBase === apiBase) throw err;
      console.log(`[api] Failover to ${newBase} for ${url}`);
      return _rawRequest(newBase, method, url, data, isGet);
    });
  });
}

function get(url, data) { return request('GET', url, data); }
function post(url, data) { return request('POST', url, data); }

function pollTask(url, interval = 2000, maxAttempts = 600, onProgress) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function check() {
      attempts++;
      if (attempts > maxAttempts) return reject(new Error('任务超时'));
      get(url).then(res => {
        if (res.status === 'completed') resolve(res);
        else if (res.status === 'failed') reject(new Error(res.error || '任务失败'));
        else { onProgress?.(res.status, res.progress, null); setTimeout(check, interval); }
      }).catch(reject);
    }
    check();
  });
}

function extractUrl(text) {
  if (!text) return '';
  const m = text.match(/(https?:\/\/[^\s"'<>，。！？、；：\u4e00-\u9fff\uff0c-\uff1b）\)]+)/);
  return m ? m[1] : '';
}

function detectPlatform(url) {
  if (!url) return '';
  if (/douyin\.com|iesdouyin\.com/.test(url)) return '抖音';
  if (/kuaishou\.com|gifshow\.com/.test(url)) return '快手';
  if (/xiaohongshu\.com|xhslink\.com/.test(url)) return '小红书';
  if (/bilibili\.com/.test(url)) return 'B站';
  if (/doubao\.com/.test(url)) return '豆包';
  if (/weibo\.com|weibo\.cn/.test(url)) return '微博';
  if (/tiktok\.com/.test(url)) return 'TikTok';
  if (/youtube\.com|youtu\.be/.test(url)) return 'YouTube';
  return '';
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Ensure a URL uses HTTPS (for thumbnail compatibility). */
function secureUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/^http:\/\//i, 'https://');
}

/** Proxy image through server to avoid CDN hotlink blocking (403). */
function proxyImage(url) {
  if (!url || typeof url !== 'string') return url;
  // Only proxy external images that might be blocked
  if (url.includes('xhscdn.com') || url.includes('hdslb.com') || url.includes('aliyuncs.com')) {
    const app = getApp();
    const base = (app && app.globalData && app.globalData.apiBase) || 'http://localhost:8800';
    return `${base}/api/video/image?url=${encodeURIComponent(url)}`;
  }
  return url;
}

module.exports = { request, get, post, pollTask, extractUrl, detectPlatform, formatDuration, formatFileSize, formatDate, secureUrl, proxyImage };