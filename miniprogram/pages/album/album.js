// pages/album/album.js
const { extractUrl, detectPlatform, post, secureUrl } = require('../../utils/api');

// 图片代理：通过服务器中转避免 CDN 防盗链
function proxyImage(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.includes('xhscdn.com') || url.includes('douyinpic.com') || url.includes('p*')) {
    const app = getApp();
    const base = (app && app.globalData && app.globalData.apiBase) || 'http://localhost:8800';
    return `${base}/api/video/image?url=${encodeURIComponent(url)}`;
  }
  return url;
}

Page({
  data: {
    isDark: false,
    url: '',
    loading: false,
    downloading: false,
    saving: false,
    error: '',
    progress: 0,
    statusText: '',
    statusHint: '',
    // 笔记数据
    noteInfo: null,
    images: [],
    imageCount: 0,
    description: '',
    // 检测
    detectedUrl: '',
    detectedPlatform: '',
  },

  onLoad() {
    this.setData({ isDark: getApp().globalData.isDark });
    this.detectClipboard();
  },

  onShow() {
    this.detectClipboard();
  },

  onThemeChange(d) { this.setData({ isDark: d }); },

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

  onUrlInput(e) { this.setData({ url: e.detail.value }); },
  clearUrl() { this.resetAll(); },

  // 粘贴并解析
  pasteAndParse() {
    if (this._busy) return;
    this._busy = true;
    wx.getClipboardData({
      success: async (res) => {
        const url = extractUrl(res.data || '');
        if (url) {
          this.setData({ url });
          await this.parseAlbum(url);
        } else {
          wx.showToast({ title: '未找到有效链接', icon: 'none' });
          this._busy = false;
        }
      },
      fail: () => { this._busy = false; },
    });
  },

  // 解析图文笔记
  async parseAlbum(url) {
    const cleanUrl = extractUrl(url);
    if (!cleanUrl) { this._busy = false; return wx.showToast({ title: '未找到有效链接', icon: 'none' }); }
    if (this.data.downloading) { this._busy = false; return; }

    this.setData({
      loading: true, error: '', noteInfo: null, images: [],
      imageCount: 0, description: '', progress: 0,
      statusText: '', statusHint: '', downloading: false,
    });

    try {
      const res = await post('/api/video/album/info', { url: cleanUrl });
      if (!res.success) throw new Error(res.error || '解析失败');

      const data = res.data;
      this.setData({
        noteInfo: data,
        images: data.images || [],
        imageCount: data.imageCount || 0,
        description: data.description || '',
        loading: false,
      });
    } catch (err) {
      this.setData({ error: err.message || '解析失败', loading: false });
    } finally {
      this._busy = false;
    }
  },

  // 复制文案
  copyDescription() {
    const text = this.data.description;
    if (!text) { wx.showToast({ title: '暂无文案', icon: 'none' }); return; }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '文案已复制', icon: 'success' }),
    });
  },

  // 全部保存到相册
  async saveAllImages() {
    const images = this.data.images;
    if (!images || images.length === 0) { wx.showToast({ title: '暂无图片', icon: 'none' }); return; }
    if (this.data.saving) return;

    this.setData({ saving: true, downloading: true, statusText: '正在保存图片...' });

    let saved = 0;
    let failed = 0;

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const pct = Math.round((i / images.length) * 100);
      this.setData({
        progress: pct,
        statusHint: `第 ${i + 1}/${images.length} 张`,
      });

      try {
        // 下载到临时文件
        const temp = await new Promise((ok, fail) => {
          wx.downloadFile({
            url: img.url,
            success: ok,
            fail,
          });
        });
        if (temp.statusCode !== 200) { failed++; continue; }

        // 保存到相册
        try {
          await wx.saveImageToPhotosAlbum({ filePath: temp.tempFilePath });
          saved++;
        } catch (authErr) {
          // 尝试请求权限
          try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch {
            wx.showToast({ title: '请在设置中开启相册权限', icon: 'none' });
            this.setData({ saving: false, downloading: false });
            return;
          }
          await wx.saveImageToPhotosAlbum({ filePath: temp.tempFilePath });
          saved++;
        }
      } catch (err) {
        console.error('[album] 保存图片失败:', err);
        failed++;
      }
    }

    this.setData({
      progress: 100,
      saving: false,
      downloading: false,
      statusText: failed > 0 ? `已保存 ${saved} 张，${failed} 张失败` : '已全部保存到相册！',
      statusHint: '',
    });

    wx.showToast({
      title: failed > 0 ? `已保存 ${saved}/${images.length} 张` : '已保存到相册',
      icon: failed > 0 ? 'none' : 'success',
    });
  },

  // 预览图片
  previewImage(e) {
    const idx = e.currentTarget.dataset.index;
    const urls = this.data.images.map(i => i.url);
    wx.previewImage({ current: urls[idx], urls });
  },

  // 跳转到下载页
  goDownload() {
    wx.switchTab({ url: '/pages/download/download' });
  },

  // 重新下载
  newDownload() {
    this._busy = false;
    this.resetAll();
  },

  resetAll() {
    this.setData({
      url: '', noteInfo: null, images: [], imageCount: 0, description: '',
      loading: false, downloading: false, saving: false, error: '',
      progress: 0, statusText: '', statusHint: '',
      detectedUrl: '',
    });
    this.detectClipboard();
  },
});