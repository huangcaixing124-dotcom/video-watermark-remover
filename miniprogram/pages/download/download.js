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

  // ── 原生模板广告事件 ──
  adLoad() {
    console.log('原生模板广告加载成功');
  },
  adError(err) {
    console.error('原生模板广告加载失败', err);
  },
  adClose() {
    console.log('原生模板广告关闭');
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
    // 仅在"还没完成、还没失败、且不是已完成的同一任务"时才重新检查，避免重复下载
    // _cachingInProgress 为 true 时传输仍在进行，无需也无需被动轮询，避免多打请求或进度回退
    // 另加存储级已完成标记：页面被销毁重建时实例字段(_downloadCompleted/_completedTaskId)会丢失，
    // 但存储标记仍在，能防止切后台再进导致"下载已完成又被重复下载"。
    if (this.data.taskId && this.data.downloading && !this._cachingInProgress && !this._downloadCompleted && !this._downloadFailed && this._completedTaskId !== this.data.taskId && !this._isTaskPersistedDone(this.data.taskId)) {
      this._checkTaskNow();
    }
  },

  // 存储级"该任务已完成"标记：跨页面销毁/重建存活，避免切后台再进重复下载。
  _isTaskPersistedDone(taskId) {
    if (!taskId) return false;
    try {
      return wx.getStorageSync('wx_done_task_id') === String(taskId);
    } catch (e) { return false; }
  },
  _markTaskPersistedDone(taskId) {
    try { wx.setStorageSync('wx_done_task_id', String(taskId)); } catch (e) {}
  },
  _clearTaskPersistedDone() {
    try { wx.removeStorageSync('wx_done_task_id'); } catch (e) {}
  },

  _checkTaskNow() {
    const taskId = this.data.taskId;
    if (!taskId) return;
    // 防止重复调用 _cacheToPhone（已有缓存任务在运行/本次已结束/已完成同一任务/存储级已完成）
    if (this._cachingInProgress) return;
    if (this._downloadCompleted || this._downloadFailed) return;
    if (this._completedTaskId === taskId) return;
    if (this._cachePromise) return;
    if (this._isTaskPersistedDone(taskId)) return;
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
  clearUrl() { this._cancelDownload(); },

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
    this._cachePromise = null; // 新一次解析，清空可能的缓存 promise
    this._precacheDone = false;
    this._precachePath = null;
    this._precachePromise = null;
    this._downloadCompleted = false;
    this._downloadFailed = false;
    this._completedTaskId = null; // 新任务开始，清空已完成标记
    this._clearTaskPersistedDone(); // 清空存储级已完成标记，允许新任务正常下载
    // 解析阶段：立即显示进度条，0→15% 平滑推进（文案"正在解析链接/视频信息"）
    this._clearParseTimer();
    this._parseFired = true;
    let parsePct = 0;
    this._parseTimer = setInterval(() => {
      parsePct = Math.min(15, parsePct + 1);
      this.setData({ progress: parsePct, statusText: '正在解析链接/视频信息', statusHint: `${parsePct}%` });
      if (parsePct >= 15) clearInterval(this._parseTimer);
    }, 180);
    this.setData({ url, loading: true, downloading: false, error: '', videoInfo: null, taskId: null, progress: 0, statusText: '正在解析链接/视频信息', statusHint: '0%' });
    try {
      const res = await post('/api/video/info', { url });
      // 解析完成，停止解析进度动画
      this._clearParseTimer();
      if (!res.success) return void this.setData({ error: res.error || '解析失败', loading: false });

      // 显示视频信息（缩略图走代理）
      const vinfo = res.data;
      if (vinfo.thumbnailUrl) vinfo.thumbnailUrl = proxyImage(vinfo.thumbnailUrl);
      this.setData({ videoInfo: vinfo });

      // 检查视频时长是否超过25分钟
      if (vinfo.tooLong) {
        this._clearParseTimer();
        this.setData({
          error: `⚠️ ${vinfo.message || '视频时长超过25分钟限制'}\n\n当前视频时长: ${vinfo.durationFormatted || '未知'}\n\n请使用其他工具下载长视频。`,
          loading: false,
        });
        return;
      }

      // 如果有 taskId，自动开始轮询下载进度
      if (res.data.taskId) {
        const taskId = res.data.taskId;
        // 解析已完成（进度条已到 15%），下载阶段从 15% 继续
        this.setData({ taskId, downloading: true, statusText: '下载中...', statusHint: '15%' });
        try {
          // 下载阶段：真实进度 0-100 映射到 15-90%（为"传输到手机"留出 90-100%）。
          // 叠加缓动层：排队/无进度回调时进度条缓慢递增，真实进度到达时取 max 接管，单调不回退。
          this._startDownloadEase();
          try {
            await pollTask(`/api/video/task/${taskId}`, 2000, 600, (st, p) => {
              const raw = Math.min(p || 0, 100);
              const mapped = 15 + Math.round((raw / 100) * 75);
              this._easeProgress = Math.max(this._easeProgress || 15, mapped); // 真实值接管缓动值
              this._applyDownloadProgress(mapped);
            });
          } finally {
            this._stopDownloadEase(); // 下载结束(成功/失败/超时)停止缓动
          }
          // 服务器下载完成，开始传输到手机（无论上次 poll 进度多少，先补到 90%，避免进度条"没走完"）
          this._cachingInProgress = true; // 提前标记，防止 _checkTaskNow 重复调用
          this.setData({ progress: 90, statusText: '正在传输到手机...', statusHint: '缓存中' });
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
      this._clearParseTimer();
      this.setData({ error: err.message || '解析失败' });
    } finally {
      this._clearParseTimer();
      this.setData({ loading: false });
      this._busy = false;
    }
  },

  // 清理解析阶段进度定时器
  _clearParseTimer() {
    if (this._parseTimer) { clearInterval(this._parseTimer); this._parseTimer = null; }
  },

  // ── 下载阶段进度缓动 ──
  // 高峰期/排队或无进度回调时，进度条在 15→85 区间缓慢递增，避免"停在15%不动"或"突然跳90%"。
  // 真实进度到达时由 pollTask 回调取 max 接管；到达 90（传输）前停止。
  _startDownloadEase() {
    this._stopDownloadEase();
    if (!this._easeProgress || this._easeProgress < 15) this._easeProgress = 15;
    // 每 2.5s +1，15→85 约 3 分钟爬满，封顶 85（不碰 90 的传输分界）
    this._easeTimer = setInterval(() => {
      if (this._easeProgress < 85) {
        this._easeProgress++;
        this._applyDownloadProgress(this._easeProgress);
      } else {
        this._stopDownloadEase();
      }
    }, 2500);
  },
  _stopDownloadEase() {
    if (this._easeTimer) { clearInterval(this._easeTimer); this._easeTimer = null; }
  },
  // 统一写下载阶段进度：真实映射值与缓动值取 max，单调不回退，封顶 90
  _applyDownloadProgress(shown) {
    const capped = Math.min(Math.max(shown, this.data.progress || 0), 90);
    this.setData({ progress: capped, statusText: '下载中...', statusHint: `${capped}%` });
  },

  // 后台缓存视频到手机，完成后才显示下载完成
  // 大文件(>80MB)走压缩接口，小文件走原接口；支持分片下载避免半路失败
  _cacheToPhone(taskId) {
    // 去重：已有一次缓存在进行中则复用，避免 onShow/_checkTaskNow 与主流程重复下载
    if (this._cachePromise) return this._cachePromise;
    this._cachePromise = new Promise((resolve) => {
      this._cachingInProgress = true;
      this._precacheDone = false;
      this._precachePath = null;
      // 取消信号：点"清空链接"时置 true，分片循环/单文件据此中止，避免污染下一次下载
      this._abortCache = false;
      this._downloadTask = null;
      this.setData({ statusText: '正在传输到手机...', statusHint: '缓存中', saving: true });

      const apiBase = getApp().globalData.apiBase;
      const MAX_RETRY = 3;

      // 先查询文件信息，决定是否走压缩、是否分片
      const resolvePlan = async () => {
        try {
          const info = await get(`/api/video/file-info/${taskId}`);
          const size = info.size || 0;
          // 分层方案：
          //   >300MB    → file-compressed 服务器后台压缩 → 分片下载压缩后的文件（提速）
          //   60-300MB  → Range 分片下载（不压缩，防单次长连接触发 530 + 断点续传）
          //   ≤60MB     → 单文件 wx.downloadFile 直接下载（快、原画质）
          // 阈值降到 60MB：常见几十 MB 的视频也走分片，避开 Cloudflare 隧道(≈300KB/s)单次拉大文件的 530。
          if (size > 300 * 1024 * 1024) {
            this.setData({ statusHint: '文件较大，正在压缩画质以加速下载...' });
            return { url: `${apiBase}/api/video/file-compressed/${taskId}`, size, chunked: true };
          }
          if (size > 60 * 1024 * 1024) {
            return { url: `${apiBase}/api/video/file/${taskId}`, size, chunked: true };
          }
          // size<=60MB 时用 file-info 拿到的 size，走单文件直连；size<0 保守走分片
          if (size <= 0) return { url: `${apiBase}/api/video/file/${taskId}`, size, chunked: true };
          return { url: `${apiBase}/api/video/file/${taskId}`, size, chunked: false };
        } catch {
          return { url: `${apiBase}/api/video/file/${taskId}`, size: 0, chunked: true };
        }
      };

      // 分片下载（按字节偏移、断点续传），返回 Promise<成功与否>
      const chunkedDownload = (url, size) => new Promise((done) => {
        const CHUNK = 2 * 1024 * 1024; // 每片 2MB
        const fs = wx.getFileSystemManager();
        const savePath = `${wx.env.USER_DATA_PATH}/video_${taskId}.mp4`;
        // 已有字节数（断点续传：整体重试时从磁盘已有部分继续，不从头下载）
        let from = 0;
        try { from = fs.statSync(savePath).size || 0; } catch {}
        if (!from) from = 0;

        const downloadRange = (start, end) => new Promise((ok, fail) => {
          // 每片最多尝试 3 次，失败则从小字节偏移继续（保留已写磁盘字节）
          const wrapped = (i) => {
            if (i >= 3) return fail(new Error('分片多次失败'));
            wx.request({
              url,
              method: 'GET',
              responseType: 'arraybuffer',
              header: { 'Range': `bytes=${start}-${end}` },
              timeout: 60000,
              success: (res) => {
                if (res.statusCode === 200 || res.statusCode === 206) {
                  try {
                    const buf = res.data;
                    fs.appendFileSync(savePath, buf);
                    return ok(buf.byteLength);
                  } catch (e) { return fail(e); }
                } else if (res.statusCode === 404) {
                  return fail({ expired: true });
                } else {
                  wrapped(i + 1); // 其它 HTTP 错误重试
                }
              },
              fail: (err) => {
                if (err && err.expired) return fail(err);
                wrapped(i + 1); // 网络波动重试下一片
              },
            });
          };
          wrapped(0);
        });

        (async () => {
          while (from < size) {
            // 取消检查：点"清空链接"时中止，避免半截文件污染下次下载
            if (this._abortCache) {
              try { fs.unlinkSync(savePath); } catch {}
              return done({ ok: false, aborted: true });
            }
            const end = Math.min(size - 1, from + CHUNK - 1);
            try {
              const n = await downloadRange(from, end);
              from += n;
              const pct = Math.min(99, 90 + Math.round((from / size) * 0.09 * 100));
              this.setData({ progress: pct });
            } catch (err) {
              if (this._abortCache) {
                try { fs.unlinkSync(savePath); } catch {}
                return done({ ok: false, aborted: true });
              }
              if (err && err.expired) return done({ ok: false, expired: true });
              // 某段失败：保留已写磁盘字节，返回失败让外层整体重试（从 from 续传）
              return done({ ok: false });
            }
          }
          this._precachePath = savePath;
          done({ ok: true });
        })();
      });

      // 单文件下载（<100MB 直接下载，用 wx.downloadFile，速度快）
      const attemptDownload = (url) => new Promise((done) => {
        let finished = false;
        const fsMgr = wx.getFileSystemManager();
        const persistPath = `${wx.env.USER_DATA_PATH}/video_${taskId}.mp4`;

        // 把临时文件固化到 USER_DATA_PATH（避免 wx.downloadFile 的 tempFilePath 被系统提前回收）
        const persistTemp = (tempFilePath, cb) => {
          try {
            fsMgr.copyFileSync(tempFilePath, persistPath);
            cb(persistPath);
          } catch (e) {
            // 复制失败则退回购 tempFilePath（仍有临时文件在）
            cb(tempFilePath);
          }
        };

        let downloadTask = null;
        try {
          downloadTask = wx.downloadFile({
            url,
            timeout: 600000, // 10分钟：给 <100MB 单文件直连留足余量（约300KB/s下100MB≈5.7分钟）
            success: (res) => {
              if (finished) return;
              finished = true;
              if (this._abortCache) { this._precachePath = null; done({ ok: false, aborted: true }); return; }
              if (res.statusCode === 200) {
                persistTemp(res.tempFilePath, (finalPath) => {
                  this._precachePath = finalPath;
                  this.setData({ progress: 100 });
                  done({ ok: true });
                });
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
        } catch (e) {
          console.error('[cache] downloadFile 启动异常:', e);
          done({ ok: false });
          return;
        }

        // 挂载到实例，供"清空链接"时 abort 中止
        this._downloadTask = downloadTask;

        // 用真实进度（downloadTask.onProgressUpdate），并做 null/方法保护避免基础库崩溃。
        // 进度映射到 90-100 区间（和服务器下载 0-90 承接），真实传输多少显示多少。
        if (downloadTask && typeof downloadTask.onProgressUpdate === 'function') {
          try {
            downloadTask.onProgressUpdate((res) => {
              if (finished) return;
              if (this._abortCache) return;
              const real = (res && typeof res.progress === 'number') ? res.progress : 0;
              const capped = Math.min(100, Math.max(90, Math.round(90 + (real / 100) * 9)));
              this.setData({ progress: capped, statusText: '正在传输到手机...', statusHint: `${capped}%` });
            });
          } catch (e) {
            console.warn('[cache] onProgressUpdate 初始化异常, 走无进度:', e);
          }
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

          // 被"清空链接"取消：直接结束，不再重试，等待 resetAll 收尾
          if (result.aborted) {
            return resolve();
          }

          if (result.ok) {
            // 下载成功
            this._precacheDone = true;
            this._cachingInProgress = false;
            this._downloadCompleted = true;
            this._downloadFailed = false;
            this._completedTaskId = taskId; // 标记该任务已完成，防止 onShow/_checkTaskNow 重复下载
            this._markTaskPersistedDone(taskId); // 存储级标记：页面销毁重建后仍能识别"已下载"，防重复下载
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
    }).finally(() => {
      // 本次缓存结束（无论成败），允许后续再次缓存
      this._cachePromise = null;
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
        } catch (e1) {
          console.error('[save] 缓存路径保存失败, filePath=', filePath, 'errMsg=', e1.errMsg || e1);
          try { await wx.authorize({ scope: 'scope.writePhotosAlbum' }); } catch (ae) {
            console.error('[save] 授权失败:', ae.errMsg || ae);
            wx.showToast({ title: '请在设置中开启相册权限', icon: 'none' });
            return;
          }
          try {
            await wx.saveVideoToPhotosAlbum({ filePath });
          } catch (e2) {
            console.error('[save] 授权后仍保存失败, errMsg=', e2.errMsg || e2);
            throw e2;
          }
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
    this._cancelDownload();
  },

  // 真正取消正在进行的下载，为下一次粘贴下载做干净准备：
  // 1) 置取消信号，让分片循环/单文件下载中止
  // 2) abort 单文件 downloadTask
  // 3) 清理本地残留的半截缓存文件
  _cancelDownload() {
    this._busy = false;
    this._abortCache = true;
    this._clearParseTimer(); // 解析阶段的进度动画一并停止
    const taskId = this.data.taskId;
    // 中止单文件下载任务
    if (this._downloadTask && typeof this._downloadTask.abort === 'function') {
      try { this._downloadTask.abort(); } catch (e) {}
    }
    this._downloadTask = null;
    // 清理残留半截缓存文件（分片路径由循环内 unlink，这里兜底删一次）
    if (taskId) {
      const fs = wx.getFileSystemManager();
      try { fs.unlinkSync(`${wx.env.USER_DATA_PATH}/video_${taskId}.mp4`); } catch (e) {}
    }
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
    this._cachePromise = null;
    this._precacheDone = false;
    this._precachePath = null;
    this._downloadTask = null;
    this._abortCache = false;
    this._completedTaskId = null;
    this._clearTaskPersistedDone(); // 重置清空链接时一并清除存储级已完成标记
    this.setData({
      url: '', videoInfo: null, taskId: null, progress: 0,
      statusText: '', statusHint: '', loading: false,
      downloading: false, saving: false, error: '',
      detectedUrl: '',
    });
    if (rescanClipboard) this.detectClipboard();
  },
});