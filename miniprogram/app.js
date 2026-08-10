// app.js
const PRIMARY_URL = 'https://api.hcxserver.xyz';
const BACKUP_URL = 'https://api-backup.hcxserver.xyz';

App({
  onLaunch() {
    const apiBase = wx.getStorageSync('api_base') || PRIMARY_URL;
    const darkMode = wx.getStorageSync('dark_mode') ?? 'auto';
    this.globalData.apiBase = apiBase;
    this.globalData.darkMode = darkMode;
    this.applyTheme(darkMode);
    this.checkConnection(apiBase);
    this.loadHistory();
  },

  setApiBase(url) {
    this.globalData.apiBase = url;
    this.globalData.usingBackup = false;
    wx.setStorageSync('api_base', url);
    this.checkConnection(url);
  },

  /**
   * 检查连接，支持自动故障转移：
   * 1. 先尝试主服务器 (api.hcxserver.xyz)
   * 2. 如果主服务器不通，自动切换到备用服务器 (api-backup.hcxserver.xyz)
   * 3. 切换后通知所有页面
   */
  checkConnection(url) {
    this.resolveServer(url).then(({ ok }) => {
      if (!ok) this._notifyPages('onConnectionChange', false, false);
    });
  },

  /**
   * 解析当前可用的服务器地址（支持故障转移）。
   * 返回 Promise<{ ok, url, usingBackup }>
   * 每次请求失败时调用，用于运行中自动切换。
   */
  resolveServer(preferredUrl) {
    const url = preferredUrl || this.globalData.apiBase || PRIMARY_URL;

    // 用户手动设置的地址不是主/备地址 → 只测这个
    if (url !== PRIMARY_URL && url !== BACKUP_URL) {
      return this._testUrl(url).then(ok => {
        this.globalData.connected = ok;
        this.globalData.usingBackup = false;
        this._notifyPages('onConnectionChange', ok, false);
        return { ok, url, usingBackup: false };
      });
    }

    // 先试主服务器
    return this._testUrl(PRIMARY_URL).then(primaryOk => {
      if (primaryOk) {
        this._setServer(PRIMARY_URL, false);
        return { ok: true, url: PRIMARY_URL, usingBackup: false };
      }

      // 主服务器不通，尝试备用服务器
      return this._testUrl(BACKUP_URL).then(backupOk => {
        if (backupOk) {
          this._setServer(BACKUP_URL, true);
          console.log('[failover] Switched to backup server');
          return { ok: true, url: BACKUP_URL, usingBackup: true };
        }
        this._setServer(null, false);
        return { ok: false, url: null, usingBackup: false };
      });
    });
  },

  /** 设置当前服务器并持久化 */
  _setServer(url, usingBackup) {
    this.globalData.connected = !!url;
    this.globalData.usingBackup = usingBackup;
    if (url) {
      this.globalData.apiBase = url;
      wx.setStorageSync('api_base', url);
      this._notifyPages('onConnectionChange', true, usingBackup);
    } else {
      this._notifyPages('onConnectionChange', false, false);
    }
  },

  /** 测试单个 URL 是否可达，返回 Promise<boolean> */
  _testUrl(url) {
    return new Promise(resolve => {
      wx.request({
        url: `${url}/api/health`,
        method: 'GET',
        timeout: 5000,
        success: () => resolve(true),
        fail: () => resolve(false),
      });
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
    apiBase: PRIMARY_URL,
    connected: false,
    usingBackup: false,
    isDark: false,
    darkMode: 'auto',
    downloadHistory: [],
  },
});