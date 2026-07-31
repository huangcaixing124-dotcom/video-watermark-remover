// Bridge content script - runs on Kuaishou pages
console.log('[Bridge] Content script loaded on', location.hostname);

// Send page cookies to background script
const cookies = document.cookie;
if (cookies) {
  console.log('[Bridge] Page cookies:', cookies.length, 'chars');
  chrome.runtime.sendMessage({ type: 'PAGE_COOKIES', cookies: cookies, url: location.href });
}

// Inject MAIN world script for fetch interception
const script = document.createElement('script');
script.textContent = `
  console.log('[Bridge] MAIN world script running');

  // Intercept all fetch responses
  const origFetch = window.fetch;
  window.fetch = function() {
    const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0]?.url;
    return origFetch.apply(this, arguments).then(async (response) => {
      if (url && (url.includes('graphql') || url.includes('photo/detail'))) {
        try {
          const clone = response.clone();
          const data = await clone.json();
          // Search for video URL in the response
          function findUrl(obj) {
            if (!obj || typeof obj !== 'object') return null;
            for (const val of Object.values(obj)) {
              if (typeof val === 'string' && (val.includes('.mp4') || val.includes('video/') || val.includes('play/'))) return val;
              const result = findUrl(val);
              if (result) return result;
            }
            return null;
          }
          const videoUrl = findUrl(data) || data?.data?.visionVideoDetail?.photo?.photoUrl;
          if (videoUrl) {
            console.log('[Bridge] Found video URL:', videoUrl.substring(0, 60));
            window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: videoUrl, title: document.title || '' }, '*');
          }
        } catch(e) {}
      }
      return response;
    });
  };

  // Also try to find video element after page loads
  setTimeout(() => {
    const v = document.querySelector('video');
    if (v && v.src && v.src.startsWith('http')) {
      window.postMessage({ type: 'BRIDGE_VIDEO_URL', url: v.src, title: document.title || '' }, '*');
    }
  }, 5000);
`;
document.documentElement.appendChild(script);
script.remove();

// Listen for video URL messages
window.addEventListener('message', (event) => {
  if (event.data.type === 'BRIDGE_VIDEO_URL') {
    console.log('[Bridge] Got video URL:', (event.data.url || '').substring(0, 60));
    chrome.runtime.sendMessage({
      type: 'VIDEO_URL',
      url: event.data.url,
      title: event.data.title || document.title
    });
  }
});