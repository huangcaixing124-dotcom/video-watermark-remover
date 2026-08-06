// pages/download/download.js
const { extractUrl, detectPlatform, post, pollTask, secureUrl, proxyImage } = require('../../utils/api');
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
      title: info ? `我在用视频解析工具下载视频：${info.title || ''}` : '视频解析工具 - 免费下载各大平台高清视频',
      path: '/pages/download/download',
    };
  },

  onShareTimeline() {
    const info = this.data.videoInfo;
    return {
      title: info ? `我在用视频解析工具下载视频：${info.title || ''}` : '视频解析工具 - 免费下载各大平台高清视频',
      query: '',
    };
  },

  onShow() {
    // 从后台切回前台时，检查任务是否已完成
    if (this.data.taskId && this.data.downloading) {
      this._checkTaskNow();
    }
  },

  _checkTaskNow() {
    const taskId = this.data.taskId;
    if (!taskId) return;
    const apiBase = getApp().globalData.apiBase;
    wx.request({
      url: `${apiBase}/api/video/task/${taskId}`,
      method: 'GET',
      timeout: 5000,
      success: (res) => {
        const data = res.data || {};
        if (data.status === 'completed') {
          // 服务器下载完成，开始下载到手机
          const dlUrl = `${apiBase}/api/video/file/${taskId}`;
          this._downloadToPhone(dlUrl);
        }
      },
    });
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

  // 粘贴并解析（一键操作）
  pasteAndDownload() {
    if (this._busy) return;
    this._busy = true;
    wx.getClipboardData({
      success: async (res) => {
        const url = extractUrl(res.data || '');
        if (url) {
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

  // ── 解析并下载 ──
  async parseVideo() {
    const url = extractUrl(this.data.url);
    if (!url) { this._busy = false; return wx.showToast({ title: '未找到有效链接', icon: 'none' }); }
    if (this.data.downloading) { this._busy = false; return; }
    this.setData({ url, loading: true, downloading: false, error: '', videoInfo: null, taskId: null, progress: 0, statusText: '', statusHint: '' });
    try {
      const res = await post('/api/video/info', { url });
      if (!res.success) return void this.setData({ error: res.error || '解析失败', loading: false });

      // 显示视频信息
      const vinfo = res.data;
      if (vinfo.thumbnailUrl) vinfo.thumbnailUrl = proxyImage(vinfo.thumbnailUrl);
      this.setData({ videoInfo: vinfo });

      const apiBase = getApp().globalData.apiBase;
      let downloadUrl = null;

      // 1. 有 directUrl → 直接通过代理下载到手机（最快）
      if (vinfo.directUrl) {
        downloadUrl = `${apiBase}/api/video/proxy?url=${encodeURIComponent(vinfo.directUrl)}`;
      }
      // 2. 有 taskId → 等服务器处理完再下载
      else if (res.data.taskId) {
        const taskId = res.data.taskId;
        this.setData({ taskId, downloading: true, statusText: '服务器处理中...', statusHint: '0%' });
        await pollTask(`/api/video/task/${taskId}`, 2000, 9999, (st, p) => {
          this.setData({ progress: p || 0, statusHint: `${p || 0}%` });
        });
        downloadUrl = `${apiBase}/api/video/file/${taskId}`;
      }

      // 3. 下载到手机（显示实时进度）
      if (downloadUrl) {
        await this._downloadToPhone(downloadUrl, res.data);
        // 添加到历史
        getApp().addToHistory({
          url, title: res.data.title, platform: res.data.platform,
          durationFormatted: res.data.durationFormatted,
          thumbnailUrl: proxyImage(secureUrl(res.data.thumbnailUrl)), taskId: res.data.taskId,
        });
        wx.showToast({ title: '下载完成', icon: 'success' });
      }
    } catch (err) {
      this.setData({ error: err.message || '解析失败' });
    } finally {
      this.setData({ loading: false });
      this._busy = false;
    }
  },

  // 下载到手机（显示实时进度）
  _downloadToPhone(url, info) {
    return new Promise((resolve) => {
      this._phoneCachePath = null;
      this.setData({ downloading: true, saving: true, statusText: '下载到手机...', statusHint: '0%', progress: 0 });

      const downloadTask = wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200) {
            this._phoneCachePath = res.tempFilePath;
          }
          this.setData({
            progress: 100,
            statusText: '下载完成！',
            statusHint: '点击下方按钮保存到相册',
            downloading: false,
            saving: false,
          });
          resolve();
        },
        fail: (err) => {
          console.error('[download] 下载到手机失败:', err);
          this.setData({
            progress: 100,
            statusText: '下载完成',
            statusHint: '点击下方按钮保存到相册',
            downloading: false,
            saving: false,
          });
          resolve();
        },
      });

      // 实时更新进度（0-100% 显示手机端真实下载进度）
      downloadTask.onProgressUpdate((res) => {
        this.setData({ progress: res.progress || 0, statusHint: `${res.progress || 0}%` });
      });
    });
  },

  // 保存到相册（直接用缓存文件）
  async saveToAlbum() {
    if (!this.data.taskId && !this._phoneCachePath) return;
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      // 优先用缓存文件
      if (this._phoneCachePath) {
        try {
          await wx.saveVideoToPhotosAlbum({ filePath: this._phoneCachePath });
        } catch {
          try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch {
            wx.showToast({ title: '请在设置中开启相册权限', icon: 'none' });
            return;
          }
          await wx.saveVideoToPhotosAlbum({ filePath: this._phoneCachePath });
        }
        wx.showToast({ title: '已保存到相册', icon: 'success' });
        setTimeout(() => this.resetAll(), 500);
        return;
      }

      // 没有缓存，下载并保存
      wx.showToast({ title: '正在下载视频...', icon: 'none', duration: 15000 });
      const apiBase = getApp().globalData.apiBase;
      const dlUrl = `${apiBase}/api/video/file/${this.data.taskId}`;
      const temp = await new Promise((ok, fail) => {
        wx.downloadFile({ url: dlUrl, success: ok, fail });
      });
      if (temp.statusCode !== 200) throw new Error(`HTTP ${temp.statusCode}`);
      await wx.saveVideoToPhotosAlbum({ tempFilePath: temp.tempFilePath });
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

  // ── 视频预览 ──
  showPreview() {
    const info = this.data.videoInfo;
    if (!info) return wx.showToast({ title: '暂无视频信息', icon: 'none' });
    const apiBase = getApp().globalData.apiBase;

    let previewUrl = '';

    // 1. 优先使用服务器本地文件
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
    this._phoneCachePath = null;
    this.detectClipboard();
  },
});