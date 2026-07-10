// pages/transcript/transcript.js
const { get, post, pollTask } = require('../../utils/api.js');

/** 从文本中提取有效 URL */
function extractUrl(text) {
  if (!text) return '';
  // 匹配 https/http 开头的 URL
  const match = text.match(/(https?:\/\/[^\s"'<>，。！？、；：\u4e00-\u9fff\uff0c-\uff1b]+)/);
  return match ? match[1] : '';
}

Page({
  data: {
    url: '',
    taskId: null,
    text: null,
    loading: false,
    progress: 0,
    statusText: '',
    progressHint: '',
    error: '',
  },

  onUrlInput(e) {
    this.setData({ url: e.detail.value });
  },

  /** 开始提取文案 */
  async startTranscript() {
    const rawUrl = this.data.url;
    const url = extractUrl(rawUrl);
    if (!url) {
      wx.showToast({ title: '未找到有效链接，请检查输入', icon: 'none' });
      return;
    }

    this.setData({ loading: true, error: '', text: null, progress: 0 });

    try {
      const res = await post('/api/transcript/start', { url, language: 'zh' });
      if (!res.success) {
        this.setData({ error: res.error || '任务创建失败' });
        return;
      }

      const taskId = res.data.id;
      this.setData({ taskId });

      // 轮询任务状态
      const statusRes = await pollTask(`/api/transcript/task/${taskId}`, 3000, 240,
        (status, progress) => {
          let statusText = '创建任务...';
          let progressHint = '';
          if (status === 'downloading') {
            statusText = '下载视频中...';
            progressHint = `${progress}% 已下载`;
          } else if (status === 'extracting') {
            statusText = '提取音频中...';
            progressHint = '正在从视频中提取音频';
          } else if (status === 'transcribing') {
            statusText = '语音转文字中...';
            progressHint = '正在识别语音，需要几分钟';
          }
          this.setData({
            progress: progress || 0,
            statusText,
            progressHint,
          });
        }
      );

      this.setData({
        text: statusRes.text,
        progress: 100,
        statusText: '提取完成！',
        progressHint: '文案已生成',
      });

      wx.showToast({ title: '文案提取成功', icon: 'success' });

    } catch (err) {
      this.setData({
        error: err.message || '文案提取失败',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 复制文案到剪贴板 */
  copyText() {
    wx.setClipboardData({
      data: this.data.text,
      success: () => {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' });
      },
    });
  },

  /** 导出 SRT 字幕文件 */
  exportSrt() {
    const { taskId } = this.data;
    if (!taskId) return;

    const app = getApp();
    const apiBase = app.globalData.apiBase || 'http://localhost:8800';
    const srtUrl = `${apiBase}/api/transcript/srt/${taskId}`;

    wx.showLoading({ title: '下载SRT字幕...' });

    wx.downloadFile({
      url: srtUrl,
      success: (res) => {
        wx.saveFile({
          tempFilePath: res.tempFilePath,
          success: () => {
            wx.hideLoading();
            wx.showToast({ title: 'SRT字幕已保存', icon: 'success' });
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: '保存失败', icon: 'none' });
          },
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '下载失败', icon: 'none' });
      },
    });
  },

  /** 重置任务 */
  resetTask() {
    this.setData({
      taskId: null,
      text: null,
      error: '',
      progress: 0,
    });
  },
});