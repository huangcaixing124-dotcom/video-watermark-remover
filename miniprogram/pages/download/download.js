// pages/download/download.js
const { extractUrl, detectPlatform, post, pollTask, secureUrl } = require('../../utils/api');
const { checkText } = require('../../utils/security');

Page({
  data: {
    isDark: false, url: '',
    videoInfo: null, taskId: null, progress: 0,
    statusText: '', statusHint: '',
    loading: false, downloading: false, saving: false,
    error: '',
    // 剪贴板检测
    detectedUrl: '', detectedPlatform: '',
    // 视频预览
    showPreview: false,
    previewUrl: '',
    previewTitle: '',
  },

  onLoad() {
    this.setData({ isDark: getApp().globalData.isDark });
    this.detectClipboard();
  },

  // ── 分享 ──
  onShareAppMessage() {
    const info = this.data.videoInfo;
    return {
      title: info ? `我在用去水印工具下载视频：${info.title || ''}` : '去水印视频工具 - 免费下载各大平台无水印视频',
      path: '/pages/download/download',
    };
  },

  onShareTimeline() {
    const info = this.data.videoInfo;
    return {
      title: info ? `我在用去水印工具下载视频：${info.title || ''}` : '去水印视频工具 - 免费下载各大平台无水印视频',
      query: '',
    };
  },

  onShow() {
    // 不再做任何自动重置操作
  },

  onThemeChange(d) { this.setData({ isDark: d }); },

  // ── 剪贴板检测 ──
  detectClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const url = extractUrl(res.data || '');
        if (url && !this.data.url) {
          this.setData({ detectedUrl: url, detectedPlatform: detectPlatform(url) || '其他' });
        }
      },
    });
  },

  // 粘贴并去水印（一键操作）
  pasteAndDownload() {
    if (this._busy) return;
    this._busy = true;
    wx.getClipboardData({
      success: async (res) => {
        const url = extractUrl(res.data || '');
        if (url) {
          // 内容安全检测
          const sec = await checkText(url);
          if (!sec.safe) {
            wx.showToast({ title: '内容违规，已拦截', icon: 'error' });
            this._busy = false;
            return;
          }
          this.setData({ url });
          this.parseVideo();
        } else {
          wx.showToast({ title: '剪贴板中未找到视频链接', icon: 'none' });
          this._busy = false;
        }
      },
      fail: () => { this._busy = false; },
    });
  },

  onUrlInput(e) { this.setData({ url: e.detail.value }); },
  clearUrl() { this.resetAll(); },

  // ── 解析并下载（合并为一个操作）──
  async parseVideo() {
    const url = extractUrl(this.data.url);
    if (!url) { this._busy = false; return wx.showToast({ title: '未找到有效链接', icon: 'none' }); }
    // 内容安全检测
    const sec = await checkText(url);
    if (!sec.safe) {
      wx.showToast({ title: '内容违规，已拦截', icon: 'error' });
      this._busy = false;
      return;
    }
    // 防止重复进入
    if (this.data.downloading) { this._busy = false; return; }
    this._precacheDone = false;
    this._precachePath = null;
    this._precachePromise = null;
    this.setData({ url, loading: true, downloading: false, error: '', videoInfo: null, taskId: null, progress: 0, statusText: '', statusHint: '' });
    try {
      const res = await post('/api/video/info', { url });
      if (!res.success) return void this.setData({ error: res.error || '解析失败', loading: false });

      // 显示视频信息
      this.setData({ videoInfo: res.data });

      // 如果有 taskId，自动开始轮询下载进度
      if (res.data.taskId) {
        const taskId = res.data.taskId;
        this.setData({ taskId, downloading: true, statusText: '下载中...', statusHint: '0%' });
        try {
          await pollTask(`/api/video/task/${taskId}`, 2000, 180, (st, p) => {
            this.setData({ progress: p || 0, statusText: '下载中...', statusHint: `${p || 0}%` });
          });
          this.setData({ progress: 50, statusText: '下载完成，正在传输到手机...', statusHint: '', downloading: false });
          // 后台缓存到手机，完成后才真正显示下载完成
          this._cacheToPhone(taskId);
          // 添加到历史
          getApp().addToHistory({
            url, title: res.data.title, platform: res.data.platform,
            durationFormatted: res.data.durationFormatted,
            thumbnailUrl: secureUrl(res.data.thumbnailUrl), taskId,
          });
          wx.showToast({ title: '下载完成', icon: 'success' });
        } catch (pollErr) {
          this.setData({ error: pollErr.message || '下载失败', downloading: false });
        }
      }
    } catch (err) {
      this.setData({ error: err.message || '解析失败' });
    } finally {
      this.setData({ loading: false });
      this._busy = false;
    }
  },

  // 后台缓存视频到手机，完成后才显示下载完成
  _cacheToPhone(taskId) {
    const apiBase = getApp().globalData.apiBase;
    const url = `${apiBase}/api/video/file/${taskId}`;

    // 继续显示进度，但状态改为"正在传输到手机"
    this.setData({ statusText: '正在传输到手机...', statusHint: '' });

    const downloadTask = wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode === 200) {
          this._precachePath = res.tempFilePath;
          // 真正完成，显示下载完成
          this.setData({
            progress: 100,
            statusText: '下载完成！',
            statusHint: '点击下方按钮保存到相册',
          });
        }
        this._precacheDone = true;
      },
      fail: () => {
        this._precacheDone = true;
        // 缓存失败，仍然显示完成，保存时走回退下载
        this.setData({
          progress: 100,
          statusText: '下载完成！',
          statusHint: '点击下方按钮保存到相册',
        });
      },
    });

    // 实时更新传输进度
    downloadTask.onProgressUpdate((res) => {
      this.setData({ progress: res.progress || 0 });
    });

    // 30秒超时保护
    setTimeout(() => {
      if (!this._precacheDone) {
        this._precacheDone = true;
        this.setData({
          progress: 100,
          statusText: '下载完成！',
          statusHint: '点击下方按钮保存到相册',
        });
      }
    }, 30000);
  },

  // 保存到相册
  async saveToAlbum() {
    if (!this.data.taskId) return;
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      let filePath = this._precachePath;

      // 如果缓存还没完成，等一下（最多等5秒）
      if (!filePath && !this._precacheDone) {
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (this._precacheDone) { clearInterval(check); resolve(); }
          }, 200);
          setTimeout(() => { clearInterval(check); resolve(); }, 5000);
        });
        filePath = this._precachePath;
      }

      // 如果缓存失败，直接下载
      if (!filePath) {
        wx.showToast({ title: '正在下载视频...', icon: 'none', duration: 10000 });
        const temp = await new Promise((ok, fail) => wx.downloadFile({
          url: `${getApp().globalData.apiBase}/api/video/file/${this.data.taskId}`,
          success: ok, fail,
        }));
        filePath = temp.tempFilePath;
      }

      // 保存到相册（权限不足时自动请求）
      try {
        await wx.saveVideoToPhotosAlbum({ filePath });
      } catch {
        try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch {
          wx.showToast({ title: '请在设置中开启相册权限', icon: 'none' });
          return;
        }
        await wx.saveVideoToPhotosAlbum({ filePath });
      }

      wx.showToast({ title: '已保存到相册', icon: 'success' });
      setTimeout(() => this.resetAll(), 500);
    } catch (err) {
      console.error('[save] error:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 下载新视频（清空状态回到初始）
  newDownload() {
    this._busy = false;
    this.resetAll();
  },

  // 重试
  retry() {
    this.parseVideo();
  },

  // 跳转到文案页
  goTranscript() { wx.switchTab({ url: '/pages/transcript/transcript' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  // ── 视频预览（优先使用服务器本地文件，避免重复下载）──
  showPreview() {
    const info = this.data.videoInfo;
    if (!info) return wx.showToast({ title: '暂无视频信息', icon: 'none' });
    const apiBase = getApp().globalData.apiBase;

    let previewUrl = '';

    // 1. 优先使用服务器本地文件（零拷贝服务）
    if (this.data.taskId) {
      previewUrl = `${apiBase}/api/video/file/${this.data.taskId}`;
    }
    // 2. 回退到 CDN 代理
    else if (info.directUrl) {
      previewUrl = `${apiBase}/api/video/proxy?url=${encodeURIComponent(info.directUrl)}`;
    } else {
      return wx.showToast({ title: '暂无预览地址', icon: 'none' });
    }

    this.setData({
      previewUrl,
      previewTitle: info.title || '视频预览',
      showPreview: true,
    });
  },

  hidePreview() { this.setData({ showPreview: false, previewUrl: '', previewTitle: '' }); },

  resetAll() {
    this.setData({
      url: '', videoInfo: null, taskId: null, progress: 0,
      statusText: '', statusHint: '', loading: false,
      downloading: false, saving: false, error: '',
      detectedUrl: '',
    });
    this.detectClipboard();
  },
});