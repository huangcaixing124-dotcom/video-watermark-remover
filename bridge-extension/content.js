// Bridge content script - runs on Douyin and Doubao pages
// Uses MAIN world script injection to interact with page

// Inject a script into the MAIN world to handle interactions
function injectMainScript() {
  const script = document.createElement('script');
  script.textContent = `
    // Auto-click download button when it appears
    function waitForButton() {
      const check = setInterval(() => {
        const btn = document.querySelector('.douyin-download-button');
        if (btn) {
          clearInterval(check);
          console.log('[Bridge] Found button, clicking...');
          btn.click();
        }
      }, 1000);
      setTimeout(() => clearInterval(check), 30000);
    }

    // Also try to get video URL from the page
    function captureVideoUrl() {
      const origFetch = window.fetch;
      window.fetch = function() {
        const url = arguments[0];
        if (typeof url === 'string' && url.includes('aweme/v1/web/aweme/detail')) {
          return origFetch.apply(this, arguments).then(async (response) => {
            const clone = response.clone();
            try {
              const data = await clone.json();
              if (data.aweme_detail && data.aweme_detail.video) {
                const play = data.aweme_detail.video.play_addr;
                if (play && play.url_list && play.url_list.length > 0) {
                  window.postMessage({
                    type: 'BRIDGE_VIDEO_URL',
                    url: play.url_list[0],
                    title: data.aweme_detail.desc || ''
                  }, '*');
                }
              }
            } catch(e) {}
            return response;
          });
        }
        return origFetch.apply(this, arguments);
      };
    }

    // Start
    if (window.location.hostname.includes('douyin.com')) {
      setTimeout(waitForButton, 2000);
      captureVideoUrl();
    }
  `;
  document.documentElement.appendChild(script);
  script.remove();
}

// Listen for video URL messages from the MAIN world
window.addEventListener('message', (event) => {
  if (event.data.type === 'BRIDGE_VIDEO_URL') {
    console.log('[Bridge] Got video URL from MAIN world');
    chrome.runtime.sendMessage({
      type: 'VIDEO_URL',
      url: event.data.url,
      title: event.data.title
    });
  }
});

injectMainScript();