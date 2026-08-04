// pages/settings/settings.js
Page({
  data: { isDark: false, apiBase: '', saving: false, connected: false, darkMode: 'auto', historyCount: 0 },

  onLoad() {
    const app = getApp();
    this.setData({
      apiBase: app.globalData.apiBase || 'https://api.hcxserver.xyz',
      connected: app.globalData.connected,
      isDark: app.globalData.isDark,
      darkMode: app.globalData.darkMode || 'auto',
      historyCount: (app.globalData.downloadHistory || []).length,
    });
  },

  // ── 分享 ──
  onShareAppMessage() {
    return {
      title: '去水印视频工具 - 免费下载抖音、快手、B站等平台无水印视频',
      path: '/pages/settings/settings',
    };
  },

  onShareTimeline() {
    return {
      title: '去水印视频工具 - 免费下载抖音、快手、B站等平台无水印视频',
      query: '',
    };
  },

  onShow() {
    this.setData({ historyCount: (getApp().globalData.downloadHistory || []).length });
  },

  onThemeChange(d) { this.setData({ isDark: d }); },
  onConnectionChange(c) { this.setData({ connected: c }); },

  onApiBaseInput(e) { this.setData({ apiBase: e.detail.value }); },

  async saveApiBase() {
    const apiBase = this.data.apiBase.trim();
    if (!apiBase) return wx.showToast({ title: '请输入服务器地址', icon: 'none' });
    this.setData({ saving: true });
    const app = getApp();
    app.setApiBase(apiBase);
    await new Promise(r => setTimeout(r, 1000));
    this.setData({ saving: false, connected: app.globalData.connected });
    wx.showToast({ title: app.globalData.connected ? '保存成功' : '保存成功，但连接失败', icon: app.globalData.connected ? 'success' : 'none' });
  },

  setDarkMode(e) {
    const mode = e.currentTarget.dataset.mode;
    getApp().setDarkMode(mode);
    this.setData({ darkMode: mode, isDark: getApp().globalData.isDark });
  },

  clearHistory() {
    wx.showModal({
      title: '确认清理',
      content: '将删除所有下载历史记录，此操作不可恢复',
      success: (res) => {
        if (res.confirm) {
          getApp().clearHistory();
          this.setData({ historyCount: 0 });
          wx.showToast({ title: '已清理', icon: 'success' });
        }
      },
    });
  },
});