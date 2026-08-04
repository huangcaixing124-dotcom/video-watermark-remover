// pages/transcript/transcript.js
const { extractUrl, post, pollTask } = require('../../utils/api');
const { checkText } = require('../../utils/security');

Page({
  data: {
    isDark: false, url: '',
    taskId: null, text: null,     // 纯文本（用于显示和一键复制）
    loading: false, progress: 0,
    statusText: '', statusHint: '',
    error: '',
    detectedUrl: '', showDetect: false,
  },

  onLoad() {
    this.setData({ isDark: getApp().globalData.isDark });
    this.detectClipboard();
  },

  // ── 分享 ──
  onShareAppMessage() {
    const text = this.data.text;
    return {
      title: text ? `文案提取：${text.slice(0, 30)}${text.length > 30 ? '...' : ''}` : '文案提取 - 视频转文字工具',
      path: '/pages/transcript/transcript',
    };
  },

  onShareTimeline() {
    const text = this.data.text;
    return {
      title: text ? `文案提取：${text.slice(0, 30)}${text.length > 30 ? '...' : ''}` : '文案提取 - 视频转文字工具',
      query: '',
    };
  },

  onThemeChange(d) { this.setData({ isDark: d }); },

  detectClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const url = extractUrl(res.data || '');
        if (url && !this.data.url) this.setData({ detectedUrl: url, showDetect: true });
      },
    });
  },

  useDetectedUrl() {
    this.setData({ url: this.data.detectedUrl, showDetect: false });
    this.startTranscript();
  },
  dismissDetect() { this.setData({ showDetect: false }); },

  pasteFromClipboard() {
    wx.getClipboardData({
      success: async (res) => {
        const url = extractUrl(res.data || '');
        if (url) {
          const sec = await checkText(url);
          if (!sec.safe) {
            wx.showToast({ title: '内容违规，已拦截', icon: 'error' });
            return;
          }
          this.setData({ url }); this.startTranscript();
        }
        else wx.showToast({ title: '未找到视频链接', icon: 'none' });
      },
    });
  },

  onUrlInput(e) { this.setData({ url: e.detail.value }); },
  clearUrl() { this.setData({ url: '', text: null, taskId: null, error: '', progress: 0, showDetect: false }); },

  async startTranscript() {
    const url = extractUrl(this.data.url);
    if (!url) return wx.showToast({ title: '未找到有效链接', icon: 'none' });
    // 内容安全检测
    const sec = await checkText(url);
    if (!sec.safe) {
      wx.showToast({ title: '内容违规，已拦截', icon: 'error' });
      return;
    }
    this.setData({ loading: true, error: '', text: null, progress: 0 });
    try {
      const res = await post('/api/transcript/start', { url, language: 'zh' });
      if (!res.success) return void this.setData({ error: res.error || '任务创建失败' });
      const taskId = res.data.id;
      this.setData({ taskId });
      // 轮询等待任务完成，返回的 status.text 是 SRT 格式
      const status = await pollTask(`/api/transcript/task/${taskId}`, 3000, 240, (st, p) => {
        const labels = { downloading: '下载视频中...', extracting: '提取音频中...', transcribing: '语音转文字中...' };
        this.setData({ progress: p || 0, statusText: labels[st] || '处理中...', statusHint: st === 'transcribing' ? '需要几分钟，请稍候' : `${p}%` });
      });
      // 从 SRT 格式中提取纯文本（去掉时间戳和序号）
      const plainText = this._stripSrtTimestamps(status.text || '');
      this.setData({ text: plainText || '（文案为空）', progress: 100, statusText: '提取完成', statusHint: '' });
      wx.showToast({ title: '文案提取成功', icon: 'success' });
    } catch (err) { this.setData({ error: err.message || '文案提取失败' }); }
    finally { this.setData({ loading: false }); }
  },

  // 从SRT格式中提取纯文本：去掉时间戳行和序号行
  _stripSrtTimestamps(srt) {
    if (!srt) return '';
    return srt.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.includes('-->') && !/^\d+$/.test(l))
      .join('\n');
  },

  // 一键复制
  copyText() {
    if (!this.data.text) return wx.showToast({ title: '没有可复制的内容', icon: 'none' });
    wx.setClipboardData({ data: this.data.text, success: () => wx.showToast({ title: '✅ 已复制到剪贴板', icon: 'success' }) });
  },

  exportSrt() {
    if (!this.data.taskId) return;
    const url = `${getApp().globalData.apiBase}/api/transcript/srt/${this.data.taskId}`;
    wx.showLoading({ title: '下载SRT...' });
    wx.downloadFile({ url, success: (r) => wx.saveFile({ tempFilePath: r.tempFilePath, success: () => { wx.hideLoading(); wx.showToast({ title: 'SRT已保存', icon: 'success' }); }, fail: () => { wx.hideLoading(); wx.showToast({ title: '保存失败', icon: 'none' }); } }), fail: () => { wx.hideLoading(); wx.showToast({ title: '下载失败', icon: 'none' }); } });
  },

  exportTxt() {
    if (!this.data.taskId) return;
    const url = `${getApp().globalData.apiBase}/api/transcript/text/${this.data.taskId}`;
    wx.showLoading({ title: '下载TXT...' });
    wx.downloadFile({ url, success: (r) => wx.saveFile({ tempFilePath: r.tempFilePath, success: () => { wx.hideLoading(); wx.showToast({ title: 'TXT已保存', icon: 'success' }); }, fail: () => { wx.hideLoading(); wx.showToast({ title: '保存失败', icon: 'none' }); } }), fail: () => { wx.hideLoading(); wx.showToast({ title: '下载失败', icon: 'none' }); } });
  },

  retry() { this.startTranscript(); },

  goDownload() { wx.switchTab({ url: '/pages/download/download' }); },
});