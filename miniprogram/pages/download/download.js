// pages/download/download.js
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
    videoInfo: null,
    taskId: null,
    loading: false,
    downloading: false,
    progress: 0,
    statusText: '',
    progressHint: '',
    error: '',
    pollTimer: null,
  },

  onUrlInput(e) {
    this.setData({ url: e.detail.value });
  },

  /** 解析视频信息 */
  async parseVideo() {
    const rawUrl = this.data.url;
    const url = extractUrl(rawUrl);
    if (!url) {
      wx.showToast({ title: '未找到有效链接，请检查输入', icon: 'none' });
      return;
    }

    this.setData({ loading: true, error: '', videoInfo: null });

    try {
      const res = await post('/api/video/info', { url });
      if (res.success) {
        this.setData({
          videoInfo: res.data,
        });
        wx.showToast({ title: '解析成功', icon: 'success' });
      } else {
        this.setData({ error: res.error || '解析失败' });
      }
    } catch (err) {
      this.setData({ error: err.message || '解析失败，请检查链接' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 下载视频 */
  async downloadVideo() {
    const rawUrl = this.data.url;
    const url = extractUrl(rawUrl);
    if (!url) {
      wx.showToast({ title: '未找到有效链接，请检查输入', icon: 'none' });
      return;
    }

    this.setData({ downloading: true, taskId: null, progress: 0, error: '' });

    try {
      const res = await post('/api/video/download', { url });
      if (!res.success) {
        this.setData({ error: res.error || '下载任务创建失败' });
        return;
      }

      const taskId = res.data.id;
      this.setData({ taskId });

      // 轮询任务状态
      const statusRes = await pollTask(`/api/video/task/${taskId}`, 2000, 180,
        (status, progress) => {
          let statusText = '创建任务...';
          let progressHint = '';
          if (status === 'pending') {
            statusText = '排队中...';
            progressHint = '正在等待下载';
          } else if (status === 'downloading') {
            statusText = '下载中...';
            progressHint = `${progress}% 已下载`;
          }
          this.setData({
            progress: progress || 0,
            statusText,
            progressHint,
          });
        }
      );

      this.setData({
        progress: 100,
        statusText: '下载完成！',
        progressHint: '正在保存到相册...',
      });

      // 保存到本地
      await this.saveToAlbum(taskId);

    } catch (err) {
      this.setData({
        error: err.message || '下载失败',
        downloading: false,
      });
    } finally {
      this.setData({ downloading: false });
    }
  },

  /** 保存到相册 */
  async saveToAlbum(taskId) {
    try {
      // 获取视频临时文件
      const app = getApp();
      const apiBase = app.globalData.apiBase || 'http://localhost:8800';
      const fileUrl = `${apiBase}/api/video/file/${taskId}`;

      // 下载视频到临时目录
      const tempRes = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: fileUrl,
          success: resolve,
          fail: reject,
        });
      });

      // 请求相册权限
      try {
        await wx.authorize({ scope: 'scope.writePhotosAlbum' });
      } catch {
        wx.showToast({ title: '请授权相册权限', icon: 'none' });
        return;
      }

      // 保存到相册
      await new Promise((resolve, reject) => {
        wx.saveVideoToPhotosAlbum({
          filePath: tempRes.tempFilePath,
          success: resolve,
          fail: reject,
        });
      });

      wx.showToast({ title: '已保存到相册', icon: 'success' });
      this.setData({ downloading: false });

    } catch (err) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  /** 清理轮询计时器 */
  onUnload() {
    if (this.data.pollTimer) {
      clearInterval(this.data.pollTimer);
    }
  },
});