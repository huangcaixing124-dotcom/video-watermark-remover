// pages/album/album.js
const { extractUrl, detectPlatform, post } = require('../../utils/api');

// 图片代理：通过服务器中转避免 CDN 防盗链（小红书/抖音都用）
function proxyImage(url) {
  if (!url || typeof url !== 'string') return url;
  if (/^https?:\/\//.test(url) && (url.includes('xhscdn') || url.includes('douyinpic') || url.includes('xiaohongshu') || url.includes('bytedance'))) {
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
    images: [],      // 每张: {url, proxy, index, selected, checked}
    imageCount: 0,
    description: '',
    selectedCount: 0,
    // 图片预览
    previewVisible: false,
    previewIndex: 0,
    previewUrl: '',
    previewTitle: '',
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
      selectedCount: 0, previewVisible: false,
    });

    try {
      const res = await post('/api/video/album/info', { url: cleanUrl });
      if (!res.success) throw new Error(res.error || '解析失败');

      const data = res.data;
      // 为每张图构建代理地址，默认全选
      const images = (data.images || []).map((item, idx) => ({
        url: item.url || item,
        proxy: proxyImage(item.url || item),
        index: idx,
        selected: true,
      }));

      this.setData({
        noteInfo: data,
        images,
        imageCount: images.length,
        description: data.description || '',
        selectedCount: images.length,
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

  // 选择/取消选择图片
  toggleSelect(e) {
    const idx = e.currentTarget.dataset.index;
    const images = this.data.images.map((img, i) => {
      if (i === idx) return { ...img, selected: !img.selected };
      return img;
    });
    const selectedCount = images.filter(i => i.selected).length;
    this.setData({ images, selectedCount });
  },

  // 全选 / 全不选
  toggleSelectAll() {
    const allSelected = this.data.selectedCount === this.data.images.length;
    const images = this.data.images.map(img => ({ ...img, selected: !allSelected }));
    this.setData({ images, selectedCount: allSelected ? 0 : images.length });
  },

  // 下载选中的图片到相册
  async saveSelectedImages() {
    const selected = this.data.images.filter(i => i.selected);
    if (selected.length === 0) { wx.showToast({ title: '请先选择图片', icon: 'none' }); return; }
    if (this.data.saving) return;

    this.setData({ saving: true, downloading: true, statusText: '正在保存图片...' });

    let saved = 0;
    let failed = 0;

    for (let i = 0; i < selected.length; i++) {
      const img = selected[i];
      const pct = Math.round((i / selected.length) * 100);
      this.setData({ progress: pct, statusHint: `第 ${i + 1}/${selected.length} 张` });

      try {
        // 通过后端代理下载图片（避免防盗链 403）
        const temp = await new Promise((ok, fail) => {
          wx.downloadFile({ url: img.proxy, success: ok, fail });
        });
        if (temp.statusCode !== 200) { failed++; continue; }

        // 保存到相册
        try {
          await wx.saveImageToPhotosAlbum({ filePath: temp.tempFilePath });
          saved++;
        } catch (authErr) {
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
      progress: 100, saving: false, downloading: false,
      statusText: failed > 0 ? `已保存 ${saved} 张，${failed} 张失败` : `已保存 ${saved} 张到相册！`,
      statusHint: '',
    });
    wx.showToast({ title: failed > 0 ? `已保存 ${saved}/${selected.length} 张` : '已保存到相册', icon: failed > 0 ? 'none' : 'success' });
  },

  // 预览图片（弹遮罩）
  previewImage(e) {
    const idx = e.currentTarget.dataset.index;
    const img = this.data.images[idx];
    this.setData({
      previewVisible: true,
      previewIndex: idx,
      previewUrl: img.proxy,
      previewTitle: `图片 ${idx + 1}/${this.data.images.length}`,
    });
  },

  closePreview() {
    this.setData({ previewVisible: false });
  },

  prevImage() {
    const idx = (this.data.previewIndex - 1 + this.data.images.length) % this.data.images.length;
    this.switchPreview(idx);
  },

  nextImage() {
    const idx = (this.data.previewIndex + 1) % this.data.images.length;
    this.switchPreview(idx);
  },

  switchPreview(idx) {
    const img = this.data.images[idx];
    this.setData({
      previewIndex: idx,
      previewUrl: img.proxy,
      previewTitle: `图片 ${idx + 1}/${this.data.images.length}`,
    });
  },

  // 下载当前预览的图片
  async downloadCurrentPreview() {
    const img = this.data.images[this.data.previewIndex];
    if (!img) return;
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showToast({ title: '正在下载...', icon: 'none' });

    try {
      const temp = await new Promise((ok, fail) => {
        wx.downloadFile({ url: img.proxy, success: ok, fail });
      });
      if (temp.statusCode !== 200) throw new Error(`HTTP ${temp.statusCode}`);
      try {
        await wx.saveImageToPhotosAlbum({ filePath: temp.tempFilePath });
      } catch (authErr) {
        try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch {
          wx.showToast({ title: '请在设置中开启相册权限', icon: 'none' });
          return;
        }
        await wx.saveImageToPhotosAlbum({ filePath: temp.tempFilePath });
      }
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (err) {
      console.error('[album] 下载当前图片失败:', err);
      wx.showToast({ title: '下载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
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
      progress: 0, statusText: '', statusHint: '', selectedCount: 0,
      previewVisible: false, previewIndex: 0, previewUrl: '', previewTitle: '',
      detectedUrl: '',
    });
    this.detectClipboard();
  },
});