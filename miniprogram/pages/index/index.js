// pages/index/index.js
const { extractUrl, detectPlatform } = require('../../utils/api');

Page({
  data: {
    isDark: false,
    connected: false,
    hasClipboard: false,
    clipboardUrl: '',
    clipboardPlatform: '',
    recentHistory: [],
  },

  onLoad() {
    const app = getApp();
    this.setData({
      isDark: app.globalData.isDark,
      connected: app.globalData.connected,
    });
    this.checkClipboard();
    this.loadRecent();
  },

  onShow() {
    this.checkClipboard();
    this.loadRecent();
  },

  onThemeChange(isDark) { this.setData({ isDark }); },
  onConnectionChange(connected) { this.setData({ connected }); },

  checkClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const url = extractUrl(res.data || '');
        this.setData({
          hasClipboard: !!url,
          clipboardUrl: url,
          clipboardPlatform: url ? (detectPlatform(url) || '其他平台') : '',
        });
      },
    });
  },

  loadRecent() {
    const app = getApp();
    this.setData({ recentHistory: (app.globalData.downloadHistory || []).slice(0, 5) });
  },

  goDownload() { wx.switchTab({ url: '/pages/download/download' }); },
  goDownloadWithUrl() {
    const app = getApp();
    app.globalData.pendingUrl = this.data.clipboardUrl;
    wx.switchTab({ url: '/pages/download/download' });
  },
  goTranscript() { wx.switchTab({ url: '/pages/transcript/transcript' }); },
  goHistory() { wx.switchTab({ url: '/pages/history/history' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },
});