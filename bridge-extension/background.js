// Video Download Bridge - polls server, uses browser cookies for Kuaishou API
const SERVER = 'http://localhost:8800';
const processedTasks = new Set();
const pendingTasks = {};
const taskTabs = {};
// 每个任务的任务类型：'video'(默认，解析播放URL) 或 'image'(图文，解析图片URL列表)。
// 打开抖音标签页时会把类型作为 __bridge_mode 查询参附加到 URL，main.js 据此决定上报视频还是图片，
// 避免"图文+视频"混合笔记在视频/图文两个路径间误上报（图文任务绝不触发 ffmpeg 视频下载，反之亦然）。
const taskTypes = {};
// 每个挂起任务的"最后期限"(Date.now式毫秒)。MV3 service worker 挂起时会取消 setTimeout，
// 所以超时改由 alarm 驱动的 checkPendingDeadlines() 统一判断，不依赖 setTimeout。
const taskDeadlines = {};
// 已完成回报的 taskId 集合：跨标签页去重的唯一保证。
// MV3 service worker 每次挂起/唤醒会重建此 Set，故持久化到 chrome.storage.local，启动时恢复。
const completedTaskIds = new Set();
const COMPLETED_KEY = 'completedTaskIds';
// 上限，防止无限增长；超出的旧 id 从持久化里整体重写丢弃
const COMPLETED_MAX = 500;

/** 从 storage 恢复已完成的 taskId，并清理超龄条目。 */
function loadCompletedTaskIds() {
  return new Promise((resolve) => {
    chrome.storage.local.get([COMPLETED_KEY], (r) => {
      const arr = (r && r[COMPLETED_KEY]) || [];
      if (Array.isArray(arr)) {
        for (const id of arr) if (typeof id === 'string') completedTaskIds.add(id);
      }
      resolve();
    });
  });
}

/** 把当前 completedTaskIds 写回 storage（截断到上限）。 */
function persistCompletedTaskIds() {
  const arr = Array.from(completedTaskIds);
  const trimmed = arr.length > COMPLETED_MAX ? arr.slice(arr.length - COMPLETED_MAX) : arr;
  chrome.storage.local.set({ [COMPLETED_KEY]: trimmed });
}

/** 平台对应的标签页处理超时(毫秒)。抖音页面重/慢，给更长窗口。 */
function tabTimeoutFor(url) {
  return url.includes('douyin.com') ? 45000 : 25000;
}

/**
 * 检查所有未完成任务是否超时：超时则关标签页 + 回报失败。
 * 由 alarm 每次触发时执行，避免 SW 挂起导致 setTimeout 失效。
 */
function checkPendingDeadlines() {
  const now = Date.now();
  for (const [url, taskId] of Object.entries(pendingTasks)) {
    const deadline = taskDeadlines[taskId];
    if (!deadline || now < deadline) continue;
    // 已超时：关标签、报错、清理
    const tabId = taskTabs[taskId];
    if (tabId) {
      chrome.tabs.remove(tabId, () => {});
      delete taskTabs[taskId];
    }
    const isDouyin = url.includes('douyin.com');
    const hint = isDouyin
      ? '抖音解析超时，请确认已安装并启用「Video Download Bridge」扩展（需真实 Edge 打开抖音解析），然后重试'
      : '解析超时，请先在 Edge 中打开 kuaishou.com 并确保能正常看到视频，然后重试';
    console.log('[Bridge] Deadline passed, reporting failure:', taskId, hint);
    reportTaskError(taskId, hint);
  }
}

async function pollForTasks() {
  try {
    // 先清理上次未完成的超时任务
    checkPendingDeadlines();

    const resp = await fetch(`${SERVER}/api/video/bridge/tasks`);
    const data = await resp.json();
    if (data.hasTask && data.url && !processedTasks.has(data.taskId)) {
      // 用户中途取消后重粘新链接时，旧的抖音标签页/任务可能还遗留(未及时回收)。
      // 单个 Edge 浏览器实际只能顺畅服务一个抖音解析任务；若让旧任务页还开着并抢报 URL，
      // 会污染新任务——正是"取消后立刻重粘失败、隔十几秒/换平台才成功"的根因。
      // 故：拿到新任务时，先把当前仍挂起的旧任务(含其标签页)全部作废，让新任务独占 Edge 上下文。
      for (const [oldUrl, oldTaskId] of Object.entries(pendingTasks)) {
        if (oldTaskId === data.taskId) continue; // 自己
        console.log(`[Bridge] 旧任务未完成，被新任务取代: ${oldTaskId} -> ${data.taskId} (${oldUrl})`);
        const oldTabId = taskTabs[oldTaskId];
        if (oldTabId) {
          chrome.tabs.remove(oldTabId, () => {});
          delete taskTabs[oldTaskId];
        }
        delete pendingTasks[oldUrl];
        delete taskDeadlines[oldTaskId];
        delete taskTypes[oldTaskId];
        if (!completedTaskIds.has(oldTaskId)) {
          // 让服务器知道旧任务没被处理完（可选），但不上报成功，避免旧页 URL 污染新任务。
          console.log('[Bridge] aborted stale task:', oldTaskId);
        }
      }
      console.log('[Bridge] New task:', data.taskId, data.url);
      processedTasks.add(data.taskId);
      pendingTasks[data.url] = data.taskId;
      taskTypes[data.taskId] = data.taskType === 'image' ? 'image' : 'video';
      taskDeadlines[data.taskId] = Date.now() + tabTimeoutFor(data.url);

      if (data.url.includes('kuaishou.com')) {
        // 先尝试用存储的 cookies 直接调 API（无需打开标签页）
        const ok = await tryDirectKuaishouApi(data.url, data.taskId);
        if (ok) return;
      }

      if (data.url.includes('doubao.com')) {
        // 豆包：尝试直接调 API 获取视频信息
        const ok = await tryDirectDoubaoApi(data.url, data.taskId);
        if (ok) return;
      }

      // 抖音：无头/直接 API 拿不到（抖音反爬，detail API 需页面内签名）。只能靠真实 Edge：
      // 打开抖音视频页，注入的 main.js 拦截 aweme/detail 响应提取播放地址回传。
      const isDouyin = data.url.includes('douyin.com');
      if (isDouyin) {
        console.log('[Bridge] Douyin task, opening real Edge tab:', data.taskId);
      }

      // 回退：打开后台标签页（不弹窗），完成后自动关闭
      // 附带 __bridge_mode 查询参把任务类型传给 main.js（视频/图文上报分流的关键）。
      const taskType = taskTypes[data.taskId] === 'image' ? 'image' : 'video';
      const tabUrl = data.url + (data.url.includes('?') ? '&' : '?') + '__bridge_mode=' + taskType;
      chrome.tabs.create({ url: tabUrl, active: false }, (tab) => {
        console.log('[Bridge] Opened background tab:', tab.id, 'mode=' + taskType);
        taskTabs[data.taskId] = tab.id;
      });

      if (processedTasks.size > 100) {
        const toDelete = Array.from(processedTasks).slice(0, 50);
        toDelete.forEach(id => processedTasks.delete(id));
      }
    }
  } catch (e) {}
}

// 从 URL 中提取视频 ID（支持短链接和真实链接）
function extractKuaishouVideoId(url) {
  // 真实链接: /short-video/3xbaetrjq3zpr5i
  let m = url.match(/kuaishou\.com\/short-video\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  // 短链接: v.kuaishou.com/nLwjQbfX
  m = url.match(/\/\/([^.]+)\.kuaishou\.com\/([a-zA-Z0-9]+)/);
  if (m) return m[2];
  // 其他格式: /photo/xxx
  m = url.match(/kuaishou\.com\/(?:photo\/)?([a-zA-Z0-9]+)/);
  if (m) return m[1];
  return null;
}

// 尝试用存储的 cookies 直接调快手 API，返回 true=成功
async function tryDirectKuaishouApi(url, taskId) {
  const result = await chrome.storage.local.get('kuaishouCookies');
  const cookieStr = result.kuaishouCookies;
  if (!cookieStr) {
    console.log('[Bridge] No stored cookies, need tab');
    return false;
  }

  const videoId = extractKuaishouVideoId(url);
  if (!videoId) return false;

  console.log('[Bridge] Trying API with stored cookies, length:', cookieStr.length);
  try {
    const gql = await fetch('https://www.kuaishou.com/graphql', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Cookie': cookieStr, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.kuaishou.com/'},
      body: JSON.stringify({ variables: { photoId: videoId }, query: 'query mistralVideo($photoId: String) { visionVideoDetail(photoId: $photoId) { status photo { id photoUrl coverUrl } } }' })
    });
    const data = await gql.json();
    console.log('[Bridge] GQL with stored cookies:', JSON.stringify(data).substring(0, 200));

    if (data?.data?.visionVideoDetail?.photo?.photoUrl) {
      const videoUrl = data.data.visionVideoDetail.photo.photoUrl;
      console.log('[Bridge] Got video URL from stored cookies:', videoUrl.substring(0, 60));
      completeTask(taskId, videoUrl);
      return true;
    }
    console.log('[Bridge] Stored cookies returned no video, need fresh tab');
    return false;
  } catch (e) {
    console.log('[Bridge] Stored cookies API error:', e.message);
    return false;
  }
}

// 尝试直接通过豆包 API 获取视频信息
async function tryDirectDoubaoApi(url, taskId) {
  const videoId = url.match(/video_id=([a-zA-Z0-9]+)/)?.[1];
  if (!videoId) return false;

  // 尝试调用服务器端 API，服务器会使用 cookies.txt 中的豆包 cookies
  try {
    const resp = await fetch(`${SERVER}/api/video/info`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ url })
    });
    const data = await resp.json();
    if (data.success && data.data?.directUrl) {
      console.log('[Bridge] Doubao video URL from server:', data.data.directUrl.substring(0, 60));
      completeTask(taskId, data.data.directUrl);
      return true;
    }
    // 有 taskId 说明服务器在后台下载中，等待完成
    if (data.success && data.data?.taskId) {
      console.log('[Bridge] Doubao task created, waiting for download...');
      // 轮询等待任务完成
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const taskResp = await fetch(`${SERVER}/api/video/task/${data.data.taskId}`);
        const taskData = await taskResp.json();
        if (taskData.status === 'completed') {
          completeTask(taskId, taskData.filePath);
          return true;
        }
        if (taskData.status === 'failed') break;
      }
    }
  } catch (e) {
    console.log('[Bridge] Doubao API error:', e.message);
  }
  return false;
}

/** 从发送者标签页反查它对应的挂起 taskId。 */
function findTaskIdForTab(sender) {
  if (!sender.tab) return null;
  for (const [url, id] of Object.entries(pendingTasks)) {
    const taskLast = url.split('/').pop() || '';
    const tabLast = (sender.tab.url || '').split('/').pop() || '';
    // 直接匹配最后一段；抖音等场景带查询参/分享跳转时，回退匹配共有的数字 ID
    if (sender.tab.url && (sender.tab.url.includes(taskLast) || url.includes(tabLast))) return id;
    const taskIdRegex = (url.match(/\/(?:video|note)\/(\d+)/) || [])[1];
    const tabIdRegex = ((sender.tab.url || '').match(/\/(?:video|note)\/(\d+)/) || [])[1];
    if (taskIdRegex && taskIdRegex === tabIdRegex) return id;
  }
  return null;
}

// Handle video URL from content script
chrome.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === 'VIDEO_URL' && message.url) {
    console.log('[Bridge] Content script found video:', message.url.substring(0, 60));
    const taskId = findTaskIdForTab(sender);
    if (taskId) {
      // 图文任务不该走视频下载；仅 video 任务 completeTask（否则图文会被误当视频去 ffmpeg 下载）
      if (taskTypes[taskId] !== 'image') {
        completeTask(taskId, message.url);
      } else {
        console.log('[Bridge] task is image, ignoring video report:', taskId);
      }
    }
  }
  // 图文任务：content script 上报图片 URL 列表（不经过 ffmpeg 视频下载）。
  if (message.type === 'ALBUM_IMAGES' && Array.isArray(message.images)) {
    console.log('[Bridge] Content script found album images:', message.images.length);
    const taskId = findTaskIdForTab(sender);
    if (taskId && !completedTaskIds.has(taskId) && taskTypes[taskId] === 'image') {
      completedTaskIds.add(taskId);
      persistCompletedTaskIds(); // 尽快持久化，避免 SW 挂起丢失去重状态
      try {
        await fetch(`${SERVER}/api/video/bridge/result`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ taskId, videoUrl: null, error: null, images: message.images })
        });
        console.log('[Bridge] Album task completed, images:', message.images.length);
        delete pendingTasks[taskId];
        delete taskDeadlines[taskId];
        delete taskTypes[taskId];
        // Auto-close the task tab
        const tabId = taskTabs[taskId];
        if (tabId) {
          chrome.tabs.remove(tabId, () => {});
          delete taskTabs[taskId];
        }
      } catch (e) {}
    }
  }
  // Handle page cookies from content script - 保存到 storage 供后续使用
  if (message.type === 'PAGE_COOKIES' && message.cookies) {
    console.log('[Bridge] Saving page cookies, length:', message.cookies.length);
    chrome.storage.local.set({ kuaishouCookies: message.cookies, cookieTime: Date.now() });
    // 尝试用这些 cookies 直接调 API
    const videoId = message.url?.match(/kuaishou\.com\/(?:short-video\/)?([a-zA-Z0-9]+)/)?.[1];
    if (videoId) {
      tryDirectKuaishouApiWithCookies(videoId, message.cookies);
    }
  }
});

// Try Kuaishou API with cookies from the page
async function tryDirectKuaishouApiWithCookies(videoId, cookieStr) {
  console.log('[Bridge] Trying API with page cookies, length:', cookieStr.length);
  try {
    const gql = await fetch('https://www.kuaishou.com/graphql', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Cookie': cookieStr, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.kuaishou.com/'},
      body: JSON.stringify({ variables: { photoId: videoId }, query: 'query mistralVideo($photoId: String) { visionVideoDetail(photoId: $photoId) { status photo { id photoUrl coverUrl } } }' })
    });
    const data = await gql.json();
    console.log('[Bridge] GQL with page cookies:', JSON.stringify(data).substring(0, 300));
    if (data?.data?.visionVideoDetail?.photo?.photoUrl) {
      const videoUrl = data.data.visionVideoDetail.photo.photoUrl;
      const taskId = Object.values(pendingTasks)[0];
      if (taskId) completeTask(taskId, videoUrl);
    }
  } catch(e) {
    console.log('[Bridge] API with page cookies error:', e.message);
  }
}

// 报告任务失败
async function reportTaskError(taskId, errorMsg) {
  console.log('[Bridge] Reporting error:', errorMsg);
  try {
    await fetch(`${SERVER}/api/video/bridge/result`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ taskId, videoUrl: null, error: errorMsg })
    });
  } catch (e) {}
  delete pendingTasks[taskId];
  delete taskDeadlines[taskId];
  delete taskTypes[taskId];
}

async function completeTask(taskId, videoUrl) {
  // 按 taskId 去重：同一任务可能被多个标签页/多个消息依次上报，
  // 只允许第一个成功的 URL 回报给服务器；后续重复一律忽略，
  // 否则服务器会对同一 taskId 并发多次下载同一 output.mp4，且晚到的失效URL会覆盖已落盘成品。
  if (completedTaskIds.has(taskId)) {
    console.log('[Bridge] Task already completed, ignoring duplicate report:', taskId);
    return;
  }
  completedTaskIds.add(taskId);
  persistCompletedTaskIds(); // 尽快持久化，避免 SW 挂起丢失去重状态

  // 仅对快/豆包等用 lr= 水印参数的平台重写为无水印；否则保持原始 URL 原样，
  // 抖音等用签名参数(watermark=/signed)的 URL 一旦改动会失效。
  const cleanUrl = videoUrl.includes('lr=') ? videoUrl.replace(/lr=[^&]+/g, 'lr=video_gen_no_watermark') : videoUrl;
  console.log('[Bridge] Original URL:', videoUrl.substring(0, 100));
  console.log('[Bridge] Cleaned URL:', cleanUrl.substring(0, 100));
  try {
    await fetch(`${SERVER}/api/video/bridge/result`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ taskId, videoUrl: cleanUrl })
    });
    console.log('[Bridge] Task completed');
    delete pendingTasks[taskId];
    delete taskDeadlines[taskId];
    delete taskTypes[taskId];
    // Auto-close the task tab
    const tabId = taskTabs[taskId];
    if (tabId) {
      chrome.tabs.remove(tabId, () => {});
      delete taskTabs[taskId];
    }
  } catch (e) {}
}

chrome.alarms.create('pollTasks', { periodInMinutes: 0.0833 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pollTasks') pollForTasks(); });
// 先恢复已完成 taskId（跨标签页去重状态），再开始轮询
loadCompletedTaskIds().then(() => {
  console.log(`[Bridge] Restored ${completedTaskIds.size} completed task ids`);
  pollForTasks();
});
console.log('[Bridge] Started');