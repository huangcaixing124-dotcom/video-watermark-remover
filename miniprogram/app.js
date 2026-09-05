// app.js
App({
  onLaunch() {
    // 唯一服务器 = Windows(api.hcxserver.xyz)。强制纠正：若缓存里存的是 api-backup(Mac)，
    // 忽略并改回 api —— 小程序永不连 Mac，避免「Mac 关闭 → 530」。
    let apiBase = wx.getStorageSync('api_base') || '';
    if (!apiBase || /api-backup\.hcxserver\.xyz/.test(apiBase)) {
      apiBase = 'https://api.hcxserver.xyz';
      try { wx.setStorageSync('api_base', apiBase); } catch {}
    }
    const darkMode = wx.getStorageSync('dark_mode') ?? 'auto';
    this.globalData.apiBase = apiBase;
    this.globalData.darkMode = darkMode;
    this.applyTheme(darkMode);
    this.checkConnection(apiBase);
    this.loadHistory();
    this.checkForUpdate();
  },

  setApiBase(url) {
    this.globalData.apiBase = url;
    wx.setStorageSync('api_base', url);
    this.checkConnection(url);
  },

  // ── 版本更新检查（仅真机/体验版生效，开发者工具不触发）──
  checkForUpdate() {
    // 基础库/低版本可能不支持 wx.getUpdateManager，合规降级为静默
    if (typeof wx.getUpdateManager !== 'function') return;
    const um = wx.getUpdateManager();
    um.onUpdateReady(() => {
      wx.showModal({
        title: '版本更新',
        content: '检测到新版本，是否立即重启应用？',
        showCancel: false, // 不显示取消，避免用户一直停留在旧版
        confirmText: '立即更新',
        success: (res) => {
          if (res.confirm) {
            um.applyUpdate(); // 强制重启并加载新版本
          }
        },
      });
    });
    um.onUpdateFailed(() => {
      // 新版下载失败，静默处理，下次冷启动再试
      console.warn('[update] 新版本下载失败，将沿用当前版本');
    });
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