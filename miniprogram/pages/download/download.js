// pages/download/download.js
const { extractUrl, detectPlatform, post, pollTask } = require('../../utils/api');

Page({
  data: {
    isDark: false, url: '',
    videoInfo: null, taskId: null, progress: 0,
    statusText: '', statusHint: '',
    loading: false, downloading: false, saving: false,
    error: '',
    // 剪贴板检测
    detectedUrl: '', detectedPlatform: '',
    showDetect: false,
    // 视频预览
    showPreview: false,
    previewUrl: '',
    previewTitle: '',
  },

  onLoad() {
    this.setData({ isDark: getApp().globalData.isDark });
    this.detectClipboard();
  },

  onShow() {
    // 如果已完成下载，检测剪贴板有没有新链接
    if (this.data.taskId && this.data.progress >= 100) {
      wx.getClipboardData({
        success: (res) => {
          const newUrl = extractUrl(res.data || '');
          if (newUrl && newUrl !== this.data.url) this.resetAll();
        },
      });
    }
  },

  onThemeChange(d) { this.setData({ isDark: d }); },

  // ── 剪贴板检测 ──
  detectClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const url = extractUrl(res.data || '');
        if (url && !this.data.url) {
          this.setData({
            detectedUrl: url, detectedPlatform: detectPlatform(url) || '其他',
            showDetect: true,
          });
        }
      },
    });
  },

  // 一键粘贴并使用
  useDetectedUrl() {
    this.setData({ url: this.data.detectedUrl, showDetect: false, detectedUrl: '' });
    this.parseVideo();
  },

  dismissDetect() { this.setData({ showDetect: false }); },

  // 手动粘贴
  pasteFromClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const url = extractUrl(res.data || '');
        if (url) {
          this.setData({ url });
          this.parseVideo();
        } else {
          wx.showToast({ title: '剪贴板中未找到视频链接', icon: 'none' });
        }
      },
    });
  },

  onUrlInput(e) { this.setData({ url: e.detail.value }); },
  clearUrl() { this.resetAll(); },

  // ── 解析 ──
  async parseVideo() {
    const url = extractUrl(this.data.url);
    if (!url) return wx.showToast({ title: '未找到有效链接', icon: 'none' });
    this.setData({ loading: true, error: '', videoInfo: null, taskId: null, progress: 0 });
    try {
      const res = await post('/api/video/info', { url });
      if (res.success) this.setData({ videoInfo: res.data });
      else this.setData({ error: res.error || '解析失败' });
    } catch (err) { this.setData({ error: err.message || '解析失败' }); }
    finally { this.setData({ loading: false }); }
  },

  // ── 下载 ──
  async downloadVideo() {
    const url = extractUrl(this.data.url);
    if (!url) return;
    this.setData({ downloading: true, taskId: null, progress: 0, error: '', statusText: '正在创建任务...', statusHint: '' });
    try {
      const res = await post('/api/video/download', { url });
      if (!res.success) return void this.setData({ error: res.error || '下载失败', downloading: false });
      const taskId = res.data.id;
      this.setData({ taskId, statusText: '下载中...', statusHint: '0%' });
      await pollTask(`/api/video/task/${taskId}`, 2000, 180, (st, p) => {
        this.setData({ progress: p || 0, statusText: '下载中...', statusHint: `${p || 0}%` });
      });
      this.setData({ progress: 100, statusText: '下载完成！', statusHint: '视频已保存到服务器' });
      getApp().addToHistory({
        url, title: this.data.videoInfo?.title, platform: this.data.videoInfo?.platform,
        durationFormatted: this.data.videoInfo?.durationFormatted,
        thumbnailUrl: this.data.videoInfo?.thumbnailUrl, taskId,
      });
      wx.showToast({ title: '下载完成', icon: 'success' });
    } catch (err) { this.setData({ error: err.message || '下载失败', downloading: false }); }
    finally { this.setData({ downloading: false }); }
  },

  // 保存到相册
  async saveToAlbum() {
    if (!this.data.taskId) return;
    this.setData({ saving: true });
    try {
      const url = `${getApp().globalData.apiBase}/api/video/file/${this.data.taskId}`;
      const temp = await new Promise((ok, fail) => wx.downloadFile({ url, success: ok, fail }));
      try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch { wx.showToast({ title: '请授权相册权限', icon: 'none' }); return; }
      await new Promise((ok, fail) => wx.saveVideoToPhotosAlbum({ filePath: temp.tempFilePath, success: ok, fail }));
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch { wx.showToast({ title: '保存失败', icon: 'none' }); }
    finally { this.setData({ saving: false }); }
  },

  // 重试
  retry() { this.parseVideo(); },

  // 跳转到文案页
  goTranscript() { wx.switchTab({ url: '/pages/transcript/transcript' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  // ── 视频预览 ──
  showPreview() {
    const info = this.data.videoInfo;
    if (!info || !info.directUrl) return wx.showToast({ title: '暂无预览地址', icon: 'none' });
    const apiBase = getApp().globalData.apiBase;
    this.setData({
      previewUrl: `${apiBase}/api/video/proxy?url=${encodeURIComponent(info.directUrl)}`,
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
      showDetect: false, detectedUrl: '',
    });
    this.detectClipboard();
  },
});