// app.js
App({
  onLaunch() {
    const apiBase = wx.getStorageSync('api_base') || 'http://localhost:8800';
    this.globalData.apiBase = apiBase;
    this.checkConnection(apiBase);
  },

  setApiBase(url) {
    this.globalData.apiBase = url;
    wx.setStorageSync('api_base', url);
    this.checkConnection(url);
  },

  checkConnection(url) {
    wx.request({
      url: `${url}/api/health`,
      method: 'GET',
      success: () => {
        this.globalData.connected = true;
      },
      fail: () => {
        this.globalData.connected = false;
        wx.showToast({
          title: '服务器连接失败',
          icon: 'none',
        });
      },
    });
  },

  globalData: {
    apiBase: 'http://localhost:8800',
    connected: false,
  },
});