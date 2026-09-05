// Bridge content script - runs on Kuaishou, Doubao and Douyin pages
console.log('[Bridge] Content script loaded on', location.hostname);

// Send page cookies to background script
const cookies = document.cookie;
if (cookies) {
  console.log('[Bridge] Page cookies:', cookies.length, 'chars');
  chrome.runtime.sendMessage({ type: 'PAGE_COOKIES', cookies: cookies, url: location.href });
}

// Inject MAIN world script via <script src> (bypasses CSP restrictions)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('main.js');
document.documentElement.appendChild(script);
script.remove();

// Listen for messages from MAIN world
window.addEventListener('message', (event) => {
  if (event.data.type === 'BRIDGE_VIDEO_URL') {
    console.log('[Bridge] Got video URL (full):', event.data.url);
    chrome.runtime.sendMessage({
      type: 'VIDEO_URL',
      url: event.data.url,
      title: event.data.title || document.title
    });
  } else if (event.data.type === 'BRIDGE_ALBUM_IMAGES') {
    // 抖音图文：MAIN world 上报图片 URL 列表，转发给 background 回报服务器
    console.log('[Bridge] Got album images:', (event.data.images || []).length);
    chrome.runtime.sendMessage({
      type: 'ALBUM_IMAGES',
      images: event.data.images || [],
      title: event.data.title || document.title
    });
  }
});