# 去水印视频工具

无水印视频下载 + 视频文案提取微信小程序。

## 功能特性

- **无水印视频下载**：支持抖音、快手、B站、小红书、TikTok、YouTube 等 1700+ 平台
- **视频文案提取**：视频语音转文字，支持导出 SRT 字幕
- **清爽明亮 UI**：现代化小程序界面

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 API | Node.js + Express |
| 视频下载 | yt-dlp (CLI) |
| 语音转文字 | faster-whisper (Python) |
| 前端 | 微信小程序 |

## 安装依赖

```bash
# Python 依赖
pip install -r requirements.txt

# Node.js 依赖
cd server && npm install
```

## 启动服务

```bash
cd server
node src/index.js
```

默认监听 `0.0.0.0:8800`

## 微信小程序

用微信开发者工具打开 `miniprogram/` 目录。

在设置页面配置服务器地址（默认 `http://localhost:8800`）。

## API 接口

### 视频解析
`POST /api/video/info` — 解析视频信息
```json
{ "url": "https://v.douyin.com/xxxxx" }
```

### 视频下载
`POST /api/video/download` — 创建下载任务
`GET /api/video/task/:id` — 查询任务状态
`GET /api/video/file/:id` — 获取视频文件

### 文案提取
`POST /api/transcript/start` — 创建文案提取任务
`GET /api/transcript/task/:id` — 查询任务状态和结果
`GET /api/transcript/text/:id` — 获取文案文本
`GET /api/transcript/srt/:id` — 获取 SRT 字幕文件

### 健康检查
`GET /api/health` — 服务健康检查
