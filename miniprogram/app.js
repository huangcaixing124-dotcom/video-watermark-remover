// app.js
App({
  onLaunch() {
    const apiBase = wx.getStorageSync('api_base') || 'https://api.hcxserver.xyz';
    const darkMode = wx.getStorageSync('dark_mode') ?? 'auto';
    this.globalData.apiBase = apiBase;
    this.globalData.darkMode = darkMode;
    this.applyTheme(darkMode);
    this.checkConnection(apiBase);
    this.loadHistory();
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
      timeout: 5000,
      success: () => {
        this.globalData.connected = true;
        this._notifyPages('onConnectionChange', true);
      },
      fail: () => {
        this.globalData.connected = false;
        this._notifyPages('onConnectionChange', false);
      },
    });
  },

  _notifyPages(method, ...args) {
    const pages = getCurrentPages();
    pages.forEach(p => { if (p[method]) p[method](...args); });
  },

  // ── Dark Mode ──
  applyTheme(mode) {
    try {
      const sys = wx.getAppBaseInfo?.() || wx.getSystemInfoSync();
      const systemDark = sys.theme === 'dark';
      const isDark = mode === 'dark' || (mode === 'auto' && systemDark);
      this.globalData.isDark = isDark;
      wx.setStorageSync('dark_mode', mode);
      wx.setNavigationBarColor({
        backgroundColor: isDark ? '#0f0f0f' : '#faf9f6',
        frontColor: isDark ? '#ffffff' : '#000000',
      });
    } catch {}
  },

  setDarkMode(mode) {
    this.globalData.darkMode = mode;
    this.applyTheme(mode);
    this._notifyPages('onThemeChange', this.globalData.isDark);
  },

  // ── Download History ──
  loadHistory() {
    try {
      this.globalData.downloadHistory = JSON.parse(wx.getStorageSync('download_history') || '[]');
    } catch { this.globalData.downloadHistory = []; }
  },

  addToHistory(item) {
    const h = this.globalData.downloadHistory || [];
    const i = h.findIndex(x => x.url === item.url);
    if (i >= 0) { h[i] = { ...h[i], ...item, downloadedAt: Date.now() }; }
    else { h.unshift({ ...item, downloadedAt: Date.now() }); }
    // 最多保留5条，超出删除最旧的
    if (h.length > 5) h.length = 5;
    this.globalData.downloadHistory = h;
    wx.setStorageSync('download_history', JSON.stringify(h));
  },

  removeFromHistory(idx) {
    const h = this.globalData.downloadHistory || [];
    h.splice(idx, 1);
    this.globalData.downloadHistory = h;
    wx.setStorageSync('download_history', JSON.stringify(h));
  },

  clearHistory() {
    this.globalData.downloadHistory = [];
    wx.setStorageSync('download_history', '[]');
  },

  globalData: {
    apiBase: 'https://api.hcxserver.xyz',
    // 大文件直连域名（公网IP + HTTPS），需在路由器做端口转发并配证书
    directBase: 'https://direct.hcxserver.xyz',
    connected: false,
    isDark: false,
    darkMode: 'auto',
    downloadHistory: [],
  },
});