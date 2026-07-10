// pages/settings/settings.js
const { get } = require('../../utils/api.js');

Page({
  data: {
    apiBase: '',
    saving: false,
    connected: false,
  },

  onLoad() {
    const app = getApp();
    this.setData({
      apiBase: app.globalData.apiBase || 'http://localhost:8800',
      connected: app.globalData.connected,
    });
  },

  onApiBaseInput(e) {
    this.setData({ apiBase: e.detail.value });
  },

  /** 保存服务器地址 */
  async saveApiBase() {
    const apiBase = this.data.apiBase.trim();
    if (!apiBase) {
      wx.showToast({ title: '请输入服务器地址', icon: 'none' });
      return;
    }

    this.setData({ saving: true });

    const app = getApp();
    app.setApiBase(apiBase);

    // 等待连接检查完成
    await new Promise(resolve => setTimeout(resolve, 1000));

    this.setData({
      saving: false,
      connected: app.globalData.connected,
    });

    if (app.globalData.connected) {
      wx.showToast({ title: '保存成功', icon: 'success' });
    } else {
      wx.showToast({ title: '保存成功，但连接失败', icon: 'none' });
    }
  },
});