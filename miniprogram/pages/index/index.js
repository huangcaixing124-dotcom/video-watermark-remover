// pages/index/index.js
Page({
  data: {
    connected: false,
  },

  onLoad() {
    const app = getApp();
    this.setData({ connected: app.globalData.connected });
  },

  goDownload() {
    wx.navigateTo({
      url: '/pages/download/download',
    });
  },

  goTranscript() {
    wx.navigateTo({
      url: '/pages/transcript/transcript',
    });
  },

  goSettings() {
    wx.navigateTo({
      url: '/pages/settings/settings',
    });
  },
});