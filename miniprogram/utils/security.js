/**
 * 微信小程序内容安全检测工具
 *
 * 对接微信公众平台内容安全 API：
 * - msgSecCheck: 文本检测
 * - imgSecCheck: 图片检测
 * - mediaCheckAsync: 媒体文件异步检测
 *
 * 审核要求：https://developers.weixin.qq.com/miniprogram/dev/framework/security.html
 */

/**
 * 检测文本内容是否安全
 * @param {string} content - 要检测的文本
 * @returns {Promise<{safe: boolean, errCode: number, errMsg: string}>}
 *
 * 使用示例：
 *   const result = await checkText('用户输入的文本');
 *   if (!result.safe) {
 *     wx.showToast({ title: '内容包含违规信息', icon: 'error' });
 *     return;
 *   }
 */
function checkText(content) {
  return new Promise((resolve) => {
    if (!content || typeof content !== 'string') {
      return resolve({ safe: true, errCode: 0, errMsg: 'empty content' });
    }

    // 只检测有效长度的文本
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return resolve({ safe: true, errCode: 0, errMsg: 'empty after trim' });
    }

    wx.msgSecCheck({
      content: trimmed.slice(0, 500), // API 限制 500KB，取前500字符足够
      success(res) {
        // errCode 0 表示安全，87014 表示内容违规
        if (res.errCode === 0) {
          resolve({ safe: true, errCode: 0, errMsg: 'safe' });
        } else {
          console.warn('[security] msgSecCheck blocked:', res.errCode, res.errMsg);
          resolve({ safe: false, errCode: res.errCode, errMsg: res.errMsg || 'risky content' });
        }
      },
      fail(err) {
        // API 调用失败（如网络问题、版本不支持等），不阻塞用户操作
        console.warn('[security] msgSecCheck call failed:', err.errMsg);
        resolve({ safe: true, errCode: -1, errMsg: err.errMsg || 'api call failed' });
      },
    });
  });
}

/**
 * 检测图片文件是否安全
 * @param {string} filePath - 图片临时文件路径
 * @returns {Promise<{safe: boolean, errCode: number}>}
 */
function checkImage(filePath) {
  return new Promise((resolve) => {
    if (!filePath) {
      return resolve({ safe: true, errCode: 0 });
    }

    wx.imgSecCheck({
      media: { filePath },
      success(res) {
        resolve({ safe: res.errCode === 0, errCode: res.errCode });
      },
      fail(err) {
        console.warn('[security] imgSecCheck failed:', err.errMsg);
        resolve({ safe: true, errCode: -1 });
      },
    });
  });
}

/**
 * 异步检测媒体文件（视频/音频）是否安全
 * @param {string} filePath - 媒体文件路径
 * @param {string} mediaType - 'video' 或 'audio'
 * @returns {Promise<{traceId: string, errCode: number}>}
 *
 * 注意：异步检测需要通过 traceId 轮询结果
 */
function checkMediaAsync(filePath, mediaType = 'video') {
  return new Promise((resolve) => {
    if (!filePath) {
      return resolve({ traceId: '', errCode: 0 });
    }

    wx.mediaCheckAsync({
      mediaType,
      media: { filePath },
      success(res) {
        resolve({ traceId: res.traceId || '', errCode: res.errCode });
      },
      fail(err) {
        console.warn('[security] mediaCheckAsync failed:', err.errMsg);
        resolve({ traceId: '', errCode: -1 });
      },
    });
  });
}

module.exports = { checkText, checkImage, checkMediaAsync };