// pages/history/history.js
Page({
  data: { isDark: false, history: [], isEmpty: true },

  onLoad() {
    const app = getApp();
    this.setData({ isDark: app.globalData.isDark });
    this.loadHistory();
  },

  // ── 分享 ──
  onShareAppMessage() {
    return {
      title: '下载历史 - 我使用视频解析工具下载的视频',
      path: '/pages/history/history',
    };
  },

  onShareTimeline() {
    return {
      title: '下载历史 - 我使用视频解析工具下载的视频',
      query: '',
    };
  },

  onShow() { this.loadHistory(); },
  onThemeChange(d) { this.setData({ isDark: d }); },

  loadHistory() {
    const app = getApp();
    const { proxyImage } = require('../../utils/api');
    const history = (app.globalData.downloadHistory || []).map(item => {
      if (item.thumbnailUrl) item.thumbnailUrl = proxyImage(item.thumbnailUrl);
      return item;
    });
    this.setData({ history, isEmpty: history.length === 0 });
  },

  deleteItem(e) {
    const idx = e.currentTarget.dataset.index;
    wx.showModal({
      title: '删除记录',
      content: '确定删除此下载记录吗？',
      success: (res) => {
        if (res.confirm) {
          getApp().removeFromHistory(idx);
          this.loadHistory();
        }
      },
    });
  },

  clearAll() {
    wx.showModal({
      title: '清空历史',
      content: '将删除所有下载记录',
      success: (res) => {
        if (res.confirm) {
          getApp().clearHistory();
          this.loadHistory();
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      },
    });
  },

  redownload(e) {
    const item = e.currentTarget.dataset.item;
    if (item.taskId) {
      const app = getApp();
      const url = `${app.globalData.apiBase}/api/video/file/${item.taskId}`;
      wx.showLoading({ title: '获取文件...' });
      wx.downloadFile({
        url,
        success: (res) => {
          wx.hideLoading();
          wx.saveVideoToPhotosAlbum({
            filePath: res.tempFilePath,
            success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
            fail: () => wx.showToast({ title: '保存失败', icon: 'none' }),
          });
        },
        fail: () => {
          wx.hideLoading();
          wx.showToast({ title: '文件已过期，请重新下载', icon: 'none' });
        },
      });
    } else {
      wx.showToast({ title: '无下载文件', icon: 'none' });
    }
  },

  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },
});