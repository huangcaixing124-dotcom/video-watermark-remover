// pages/download/download.js
const { extractUrl, detectPlatform, post, get, pollTask, secureUrl, proxyImage } = require('../../utils/api');
const { checkText } = require('../../utils/security');

Page({
  data: {
    isDark: false, url: '',
    videoInfo: null, taskId: null, progress: 0,
    statusText: '', statusHint: '',
    loading: false, downloading: false, saving: false,
    error: '',
    // 剪贴板检测
    detectedUrl: '', detectedPlatform: '',
    // 视频预览
    showPreview: false,
    previewUrl: '',
    previewTitle: '',
  },

  onLoad() {
    this.setData({ isDark: getApp().globalData.isDark });
    this.detectClipboard();
  },

  // ── 分享 ──
  onShareAppMessage() {
    const info = this.data.videoInfo;
    return {
      title: info ? `我在用视频工具下载视频：${info.title || ''}` : '视频解析工具 - 免费下载各大平台高清视频',
      path: '/pages/download/download',
    };
  },

  onShareTimeline() {
    const info = this.data.videoInfo;
    return {
      title: info ? `我在用视频工具下载视频：${info.title || ''}` : '视频解析工具 - 免费下载各大平台高清视频',
      query: '',
    };
  },

  onShow() {
    // 从后台切回前台时，检查任务状态（避免轮询延迟）
    // 仅在"还没完成、还没失败"时才重新检查，避免重复下载
    if (this.data.taskId && this.data.downloading && !this._downloadCompleted && !this._downloadFailed) {
      this._checkTaskNow();
    }
  },

  _checkTaskNow() {
    const taskId = this.data.taskId;
    if (!taskId) return;
    // 防止重复调用 _cacheToPhone（已有缓存任务在运行/本次已结束）
    if (this._cachingInProgress) return;
    if (this._downloadCompleted || this._downloadFailed) return;
    const apiBase = getApp().globalData.apiBase;
    wx.request({
      url: `${apiBase}/api/video/task/${taskId}`,
      method: 'GET',
      timeout: 5000,
      success: (res) => {
        const data = res.data || {};
        if (data.status === 'completed' && !this._precacheDone) {
          this.setData({ progress: 80, statusText: '正在传输到手机...', statusHint: '缓存中' });
          this._cacheToPhone(taskId);
        }
      },
    });
  },

  onThemeChange(d) { this.setData({ isDark: d }); },

  // ── 剪贴板检测 ──
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

  // 粘贴并解析（一键操作）
  pasteAndDownload() {
    if (this._busy) return;
    this._busy = true;
    wx.getClipboardData({
      success: async (res) => {
        const url = extractUrl(res.data || '');
        if (url) {
          // 内容安全检测
          const sec = await checkText(url);
          if (!sec.safe) {
            wx.showToast({ title: '内容违规，已拦截', icon: 'error' });
            this._busy = false;
            return;
          }
          this.setData({ url });
          this.parseVideo();
        } else {
          wx.showToast({ title: '剪贴板中未找到视频链接', icon: 'none' });
          this._busy = false;
        }
      },
      fail: () => { this._busy = false; },
    });
  },

  onUrlInput(e) { this.setData({ url: e.detail.value }); },
  clearUrl() { this._busy = false; this.resetAll(); },

  // ── 解析并下载（合并为一个操作）──
  async parseVideo() {
    const url = extractUrl(this.data.url);
    if (!url) { this._busy = false; return wx.showToast({ title: '未找到有效链接', icon: 'none' }); }
    // 内容安全检测
    const sec = await checkText(url);
    if (!sec.safe) {
      wx.showToast({ title: '内容违规，已拦截', icon: 'error' });
      this._busy = false;
      return;
    }
    // 防止重复进入
    if (this.data.downloading) { this._busy = false; return; }
    this._precacheDone = false;
    this._precachePath = null;
    this._precachePromise = null;
    this._downloadCompleted = false;
    this._downloadFailed = false;
    this.setData({ url, loading: true, downloading: false, error: '', videoInfo: null, taskId: null, progress: 0, statusText: '', statusHint: '' });
    try {
      const res = await post('/api/video/info', { url });
      if (!res.success) return void this.setData({ error: res.error || '解析失败', loading: false });

      // 显示视频信息（缩略图走代理）
      const vinfo = res.data;
      if (vinfo.thumbnailUrl) vinfo.thumbnailUrl = proxyImage(vinfo.thumbnailUrl);
      this.setData({ videoInfo: vinfo });

      // 检查视频时长是否超过25分钟
      if (vinfo.tooLong) {
        this.setData({
          error: `⚠️ ${vinfo.message || '视频时长超过25分钟限制'}\n\n当前视频时长: ${vinfo.durationFormatted || '未知'}\n\n请使用其他工具下载长视频。`,
          loading: false,
        });
        return;
      }

      // 如果有 taskId，自动开始轮询下载进度
      if (res.data.taskId) {
        const taskId = res.data.taskId;
        this.setData({ taskId, downloading: true, statusText: '下载中...', statusHint: '0%' });
        try {
          await pollTask(`/api/video/task/${taskId}`, 2000, 600, (st, p) => {
            // 限制最大 90%，为"传输到手机"阶段留出 90-100% 空间，进度条单调递增不回退
            const capped = Math.min(p || 0, 90);
            this.setData({ progress: capped, statusText: '下载中...', statusHint: `${capped}%` });
          });
          // 服务器下载完成，开始传输到手机（进度从 90% 继续，不回退）
          this._cachingInProgress = true; // 提前标记，防止 _checkTaskNow 重复调用
          this.setData({ statusText: '正在传输到手机...', statusHint: '缓存中' });
          // 后台缓存到手机
          await this._cacheToPhone(taskId);
          // 添加到历史
          getApp().addToHistory({
            url, title: res.data.title, platform: res.data.platform,
            durationFormatted: res.data.durationFormatted,
            thumbnailUrl: proxyImage(secureUrl(res.data.thumbnailUrl)), taskId,
          });
          wx.showToast({ title: '下载完成', icon: 'success' });
        } catch (pollErr) {
          // 区分超时、任务不存在和其他错误
          const errMsg = pollErr.message || '';
          if (errMsg.includes('超时') || errMsg.includes('timeout')) {
            this.setData({ error: '下载超时，请重试。如果问题持续，请检查网络后重试。', downloading: false });
          } else if (errMsg.includes('404') || errMsg.includes('不存在') || errMsg.includes('已过期')) {
            this.setData({ error: '任务不存在（服务器可能已重启），请重新解析', downloading: false });
          } else {
            this.setData({ error: errMsg, downloading: false });
          }
        }
      }
    } catch (err) {
      this.setData({ error: err.message || '解析失败' });
    } finally {
      this.setData({ loading: false });
      this._busy = false;
    }
  },

  // 后台缓存视频到手机，完成后才显示下载完成
  // 大文件(>80MB)走压缩接口，小文件走原接口；支持分片下载避免半路失败
  _cacheToPhone(taskId) {
    return new Promise((resolve) => {
      this._cachingInProgress = true;
      this._precacheDone = false;
      this._precachePath = null;
      this.setData({ statusText: '正在传输到手机...', statusHint: '缓存中', saving: true });

      const apiBase = getApp().globalData.apiBase;
      const MAX_RETRY = 3;

      // 先查询文件信息，决定是否走压缩、是否分片
      const resolvePlan = async () => {
        try {
          const info = await get(`/api/video/file-info/${taskId}`);
          const size = info.size || 0;
          if (info.needCompress) {
            this.setData({ statusHint: '文件较大，正在压缩画质...' });
          }
          const url = info.needCompress
            ? `${apiBase}/api/video/file-compressed/${taskId}`
            : `${apiBase}/api/video/file/${taskId}`;
          return { url, size, chunked: size > 5 * 1024 * 1024 }; // >5MB 用分片
        } catch {
          return { url: `${apiBase}/api/video/file/${taskId}`, size: 0, chunked: false };
        }
      };

      // 分片下载（支持断点续传），返回 Promise<成功与否>
      const chunkedDownload = (url, size) => new Promise((done) => {
        const CHUNK = 2 * 1024 * 1024; // 每片 2MB
        const totalChunks = Math.ceil(size / CHUNK);
        let current = 0; // 当前已下载字节
        let downloadedBytes = 0;
        const fs = wx.getFileSystemManager();
        const savePath = `${wx.env.USER_DATA_PATH}/video_${taskId}.mp4`;
        let bufferQueue = []; // 顺序写入缓冲区

        const writeNext = () => {
          // 需要按顺序写入，这里用一个简单顺序标记
        };

        const downloadChunk = (chunkIdx) => new Promise((chunkOk, chunkFail) => {
          const start = chunkIdx * CHUNK;
          const end = Math.min(size - 1, start + CHUNK - 1);
          wx.request({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            header: { 'Range': `bytes=${start}-${end}` },
            timeout: 60000,
            success: (res) => {
              if (res.statusCode === 200 || res.statusCode === 206) {
                // 写到文件（追加模式）
                const buf = res.data;
                try {
                  if (chunkIdx === 0) {
                    fs.writeFileSync(savePath, buf);
                  } else {
                    fs.appendFileSync(savePath, buf);
                  }
                  downloadedBytes += buf.byteLength;
                  chunkOk();
                } catch (e) {
                  chunkFail(e);
                }
              } else if (res.statusCode === 404) {
                chunkFail({ expired: true });
              } else {
                chunkFail(new Error(`HTTP ${res.statusCode}`));
              }
            },
            fail: (err) => chunkFail(err),
          });
        });

        // 串行下载所有分片（避免并发乱序）
        (async () => {
          for (let i = 0; i < totalChunks; i++) {
            try {
              await downloadChunk(i);
            } catch (err) {
              // 单个分片失败，重试当前分片
              let retried = false;
              for (let r = 0; r < 2 && !retried; r++) {
                try {
                  await downloadChunk(i);
                  retried = true;
                } catch (e) {
                  if (e.expired) {
                    return done({ ok: false, expired: true });
                  }
                }
              }
              if (!retried) return done({ ok: false }); // 分片多次失败
            }
            // 更新进度（90-99%，单调递增不回退）
            const pct = Math.min(99, 90 + Math.floor(((i + 1) / totalChunks) * 0.09 * 100));
            this.setData({ progress: pct });
          }
          // 全部下载完成
          this._precachePath = savePath;
          done({ ok: true });
        })();
      });

      // 单文件下载（小文件用 wx.downloadFile，速度快）
      const attemptDownload = (url) => new Promise((done) => {
        let finished = false;
        const downloadTask = wx.downloadFile({
          url,
          timeout: 300000,
          success: (res) => {
            if (finished) return;
            finished = true;
            if (res.statusCode === 200) {
              this._precachePath = res.tempFilePath;
              done({ ok: true });
            } else if (res.statusCode === 404) {
              done({ ok: false, expired: true });
            } else {
              done({ ok: false });
            }
          },
          fail: (err) => {
            if (finished) return;
            finished = true;
            console.error('[cache] 单次下载失败:', err);
            done({ ok: false });
          },
        });

        // 防御: downloadTask 可能为 null（异常情况），避免 .on 崩溃
        if (downloadTask && typeof downloadTask.onProgressUpdate === 'function') {
          downloadTask.onProgressUpdate((res) => {
            this.setData({ progress: Math.min(99, 90 + Math.floor(res.progress * 0.09 * 100)) });
          });
        }
      });

      // 带重试的下载（根据文件大小选择单文件或分片下载）
      (async () => {
        const plan = await resolvePlan();
        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
          if (attempt > 1) {
            this.setData({ statusHint: `重试第 ${attempt - 1}/${MAX_RETRY - 1} 次...` });
          }
          const result = plan.chunked
            ? await chunkedDownload(plan.url, plan.size)
            : await attemptDownload(plan.url);

          if (result.ok) {
            // 下载成功
            this._precacheDone = true;
            this._cachingInProgress = false;
            this._downloadCompleted = true;
            this._downloadFailed = false;
            this.setData({
              progress: 100,
              statusText: '下载完成！',
              statusHint: '点击下方按钮保存到相册',
              downloading: false,
              saving: false,
            });
            return resolve();
          }

          if (result.expired) {
            // 文件已过期，无需重试
            this._precacheDone = true;
            this._cachingInProgress = false;
            this._downloadCompleted = true;
            this.setData({
              progress: 0,
              statusText: '文件不可用',
              statusHint: '',
              downloading: false,
              saving: false,
              error: '视频文件已过期，请重新解析下载',
            });
            return resolve();
          }

          // 网络失败，如果还有重试次数则继续
          if (attempt < MAX_RETRY) {
            await new Promise(r => setTimeout(r, attempt * 1000));
          }
        }

        // 所有重试都失败
        this._precacheDone = true;
        this._cachingInProgress = false;
        this._downloadFailed = true;
        this.setData({
          progress: 0,
          statusText: '下载失败',
          statusHint: '请检查网络后重试',
          downloading: false,
          saving: false,
          error: '下载到手机失败，已重试多次，请检查网络后重试',
        });
        resolve();
      })();
    });
  },

  // 保存到相册
  async saveToAlbum() {
    if (!this.data.taskId) return;
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      let filePath = this._precachePath;

      // 如果缓存还在下载中，等一下
      if (!filePath && !this._precacheDone) {
        wx.showToast({ title: '等待传输完成...', icon: 'none', duration: 5000 });
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (this._precacheDone) { clearInterval(check); resolve(); }
          }, 500);
          // 不限时，等下载自然完成
          setTimeout(() => { clearInterval(check); resolve(); }, 300000); // 5分钟超时保护
        });
        filePath = this._precachePath;
      }

      // 有缓存文件，直接用
      if (filePath) {
        try {
          await wx.saveVideoToPhotosAlbum({ filePath });
        } catch {
          try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch {
            wx.showToast({ title: '请在设置中开启相册权限', icon: 'none' });
            return;
          }
          await wx.saveVideoToPhotosAlbum({ filePath });
        }
        wx.showToast({ title: '已保存到相册', icon: 'success' });
        // 保存成功后只清空缓存引用，不重置页面（避免触发剪贴板重嗅探回到解析态）
        this._precachePath = null;
        this._precacheDone = false;
        this._cachingInProgress = false;
        setTimeout(() => this.resetAll(false), 800);
        return;
      }

      // 缓存失败，下载并保存
      wx.showToast({ title: '正在下载视频...', icon: 'none', duration: 15000 });
      const temp = await new Promise((ok, fail) => wx.downloadFile({
        url: `${getApp().globalData.apiBase}/api/video/file/${this.data.taskId}`,
        success: ok, fail,
      }));
      if (temp.statusCode !== 200) {
        console.error('[save] 文件下载失败, HTTP:', temp.statusCode);
        wx.showToast({ title: '视频文件已过期，请重新解析下载', icon: 'none' });
        return;
      }
      await wx.saveVideoToPhotosAlbum({ tempFilePath: temp.tempFilePath });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
      this._precachePath = null;
      this._precacheDone = false;
      this._cachingInProgress = false;
      setTimeout(() => this.resetAll(false), 800);
    } catch (err) {
      console.error('[save] error:', err);
      // 区分 404 和其他错误，给出更明确的提示
      if (err.message && err.message.includes('404')) {
        wx.showToast({ title: '视频文件已过期，请重新解析', icon: 'none' });
      } else {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    } finally {
      this.setData({ saving: false });
    }
  },

  // 下载新视频（清空状态回到初始）
  newDownload() {
    this._busy = false;
    this.resetAll();
  },

  // 重试
  retry() {
    this.parseVideo();
  },

  // 跳转到文案页
  goTranscript() { wx.switchTab({ url: '/pages/transcript/transcript' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  // ── 视频预览（优先使用服务器本地文件，避免重复下载）──
  showPreview() {
    const info = this.data.videoInfo;
    if (!info) return wx.showToast({ title: '暂无视频信息', icon: 'none' });
    const apiBase = getApp().globalData.apiBase;

    let previewUrl = '';

    // 1. 优先使用服务器本地文件（零拷贝服务）
    if (this.data.taskId) {
      previewUrl = `${apiBase}/api/video/file/${this.data.taskId}`;
    }
    // 2. 回退到 CDN 代理
    else if (info.directUrl) {
      previewUrl = `${apiBase}/api/video/proxy?url=${encodeURIComponent(info.directUrl)}`;
    } else {
      return wx.showToast({ title: '暂无预览地址', icon: 'none' });
    }

    this.setData({
      previewUrl,
      previewTitle: info.title || '视频预览',
      showPreview: true,
    });
  },

  hidePreview() { this.setData({ showPreview: false, previewUrl: '', previewTitle: '' }); },

  // 重置页面。默认重新嗅探剪贴板；rescanClipboard=false 用于保存成功后（避免再次进入解析态）
  resetAll(rescanClipboard = true) {
    this._downloadCompleted = false;
    this._downloadFailed = false;
    this._cachingInProgress = false;
    this._precacheDone = false;
    this._precachePath = null;
    this.setData({
      url: '', videoInfo: null, taskId: null, progress: 0,
      statusText: '', statusHint: '', loading: false,
      downloading: false, saving: false, error: '',
      detectedUrl: '',
    });
    if (rescanClipboard) this.detectClipboard();
  },
});