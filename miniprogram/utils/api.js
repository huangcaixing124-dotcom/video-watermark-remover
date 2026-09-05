/**
 * API 调用封装
 */
const app = getApp();

// 设备级用户标识：无登录，生成本地持久化的 uuid 区分不同手机/用户。
// 服务端据此按用户隔离「新任务顶替旧任务」，绝不误伤其他用户。
function getUserId() {
  try {
    let id = wx.getStorageSync('bridge_user_id');
    if (!id) {
      id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync('bridge_user_id', id);
    }
    return id;
  } catch (e) { return 'u_' + Math.random().toString(36).slice(2, 10); }
}

function request(method, url, data = {}) {
  return new Promise((resolve, reject) => {
    // 唯一入口：只用 api.hcxserver.xyz（Cloudflare Worker → Windows 主）。
    // 去掉 api-backup(Mac)：小程序不再连 Mac，避免「Mac 关闭 → 530」。
    // Worker 侧已做 Windows 优先/故障转移，Windows 待在时 Mac 与否不影响；且即便未来想用 Mac 兜底，
    // 也由 Worker 在 api 内部完成，小程序不直接碰 api-backup 域名。
    const HOSTS = [
      app.globalData.apiBase || 'https://api.hcxserver.xyz',
    ].filter((h, i, a) => h && typeof h === 'string' && i === a.indexOf(h)); // 去重、去空

    // 单次请求实际执行器
    const doRequest = (base) => new Promise((res2, rej2) => {
      const isGet = method === 'GET';
      const headers = { ...(isGet ? {} : { 'Content-Type': 'application/json' }), 'X-User-Id': getUserId() };
      wx.request({
        url: `${base}${url}`,
        method,
        data: isGet ? data : JSON.stringify(data),
        dataType: 'json',
        header: headers,
        timeout: 120000,
        success: (res) => {
          if (res.statusCode === 200) res2(res.data);
          else rej2({ statusCode: res.statusCode, message: res.data?.error || `HTTP ${res.statusCode}` });
        },
        fail: () => rej2({ statusCode: 0, message: '网络请求失败，请检查服务器地址' }),
      });
    });

    // 可重试：530 / 5xx（隧道/网关不稳定）或网络失败(0)；4xx 等业务错误直接抛出、不切入口。
    const RETRYABLE = (code) => code === 530 || (code >= 500 && code <= 599) || code === 0;
    (async () => {
      let lastErr = null;
      for (const base of HOSTS) {
        try {
          // 成功即返回；任一可用即成功（Windows/Mac 互为备份）
          return resolve(await doRequest(base));
        } catch (e) {
          lastErr = e;
          const code = e && e.statusCode;
          // 业务错误(4xx)——切换入口也无济于事，立即失败
          if (typeof code === 'number' && code !== 0 && !RETRYABLE(code)) break;
          // 可重试：短暂间隔后切换下一个入口
          await new Promise(r => setTimeout(r, 600));
        }
      }
      const msg = lastErr && lastErr.message;
      // 把隧道偶发的 530 翻译成友好文案，避免手机端看到冷冰冰的"530"
      reject(new Error(msg === 'HTTP 530' ? '网络波动，请重试（530）' : (msg || '请求失败')));
    })();
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