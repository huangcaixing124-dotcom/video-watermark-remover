/**
 * API 调用封装
 */
const app = getApp();

/**
 * 发送 API 请求
 * @param {string} method - HTTP 方法
 * @param {string} url - 相对路径
 * @param {object} data - 请求数据
 */
function request(method, url, data = {}) {
  return new Promise((resolve, reject) => {
    const apiBase = app.globalData.apiBase || 'http://localhost:8800';
    const fullUrl = `${apiBase}${url}`;

    wx.request({
      url: fullUrl,
      method: method,
      data: data,
      header: {
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      success: (res) => {
        console.log('[API] ' + method + ' ' + url + ' -> ' + res.statusCode, res.data);
        if (res.statusCode === 200) {
          resolve(res.data);
        } else {
          const errMsg = res.data?.error || `HTTP ${res.statusCode}`;
          reject(new Error(errMsg));
        }
      },
      fail: (err) => {
        console.error('[API] Request failed:', method, url, err);
        reject(new Error('网络请求失败，请检查服务器地址'));
      },
    });
  });
}

/** GET 请求 */
function get(url, data = {}) {
  return request('GET', url, data);
}

/** POST 请求 */
function post(url, data = {}) {
  return request('POST', url, data);
}

/**
 * 轮询任务状态
 * @param {string} url - 任务查询路径
 * @param {number} interval - 轮询间隔（毫秒）
 * @param {number} maxAttempts - 最大尝试次数
 * @param {function} onProgress - 进度回调: (status, progress, error) => void
 */
function pollTask(url, interval = 2000, maxAttempts = 180, onProgress) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function check() {
      attempts++;
      if (attempts > maxAttempts) {
        reject(new Error('任务超时'));
        return;
      }

      get(url).then((res) => {
        if (res.status === 'completed') {
          resolve(res);
        } else if (res.status === 'failed') {
          reject(new Error(res.error || '任务失败'));
        } else {
          onProgress?.(res.status, res.progress, null);
          setTimeout(check, interval);
        }
      }).catch((err) => {
        reject(err);
      });
    }

    check();
  });
}

module.exports = {
  request,
  get,
  post,
  pollTask,
};