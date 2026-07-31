// Video Download Bridge - polls server, uses browser cookies for Kuaishou API
const SERVER = 'http://localhost:8800';
const processedTasks = new Set();
const pendingTasks = {};
const taskTabs = {};

async function pollForTasks() {
  try {
    const resp = await fetch(`${SERVER}/api/video/bridge/tasks`);
    const data = await resp.json();
    if (data.hasTask && data.url && !processedTasks.has(data.taskId)) {
      console.log('[Bridge] New task:', data.taskId, data.url);
      processedTasks.add(data.taskId);
      pendingTasks[data.url] = data.taskId;

      if (data.url.includes('kuaishou.com')) {
        // 先尝试用存储的 cookies 直接调 API（无需打开标签页）
        const ok = await tryDirectKuaishouApi(data.url, data.taskId);
        if (ok) return; // 成功了，不需要打开标签页
      }

      // 回退：打开后台标签页（不弹窗），完成后自动关闭
      chrome.tabs.create({ url: data.url, active: false }, (tab) => {
        console.log('[Bridge] Opened background tab:', tab.id);
        taskTabs[data.taskId] = tab.id;
      });

      // 30秒超时自动关闭标签页
      setTimeout(() => {
        const tabId = taskTabs[data.taskId];
        if (tabId) {
          chrome.tabs.remove(tabId, () => {});
          delete taskTabs[data.taskId];
        }
      }, 30000);

      if (processedTasks.size > 100) {
        const toDelete = Array.from(processedTasks).slice(0, 50);
        toDelete.forEach(id => processedTasks.delete(id));
      }
    }
  } catch (e) {}
}

// 尝试用存储的 cookies 直接调快手 API，返回 true=成功
async function tryDirectKuaishouApi(url, taskId) {
  // 从 storage 读取之前保存的 cookies
  const result = await chrome.storage.local.get('kuaishouCookies');
  const cookieStr = result.kuaishouCookies;
  if (!cookieStr) {
    console.log('[Bridge] No stored cookies, need tab');
    return false;
  }

  const videoId = url.match(/kuaishou\.com\/(?:short-video\/)?([a-zA-Z0-9]+)/)?.[1];
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

// Handle video URL from content script
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'VIDEO_URL' && message.url) {
    console.log('[Bridge] Content script found video:', message.url.substring(0, 60));
    let taskId = null;
    if (sender.tab) {
      for (const [url, id] of Object.entries(pendingTasks)) {
        if (sender.tab.url && (sender.tab.url.includes(url.split('/').pop()) || url.includes(sender.tab.url.split('/').pop()))) {
          taskId = id; break;
        }
      }
    }
    if (taskId) {
      completeTask(taskId, message.url);
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

async function completeTask(taskId, videoUrl) {
  try {
    await fetch(`${SERVER}/api/video/bridge/result`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ taskId, videoUrl })
    });
    console.log('[Bridge] Task completed');
    delete pendingTasks[taskId];
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
pollForTasks();
console.log('[Bridge] Started');