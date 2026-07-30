// Douyin Video Bridge - polls server for tasks, opens tabs in real Edge
const SERVER = 'http://localhost:8800';
const processedTasks = new Set();

// Poll the server for new parsing tasks
async function pollForTasks() {
  try {
    const resp = await fetch(`${SERVER}/api/video/bridge/tasks`);
    const data = await resp.json();

    if (data.hasTask && data.url && !processedTasks.has(data.taskId)) {
      console.log('[Bridge] New task:', data.taskId, data.url);
      processedTasks.add(data.taskId);

      // Open the URL in a new tab
      chrome.tabs.create({ url: data.url, active: true }, (tab) => {
        console.log('[Bridge] Opened tab:', tab.id);
      });

      // Clean up old processed tasks
      if (processedTasks.size > 100) {
        const toDelete = Array.from(processedTasks).slice(0, 50);
        toDelete.forEach(id => processedTasks.delete(id));
      }
    }
  } catch (e) {
    // Server not available
  }
}

// Listen for completed downloads and report to server
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state && delta.state.current === 'complete') {
    const items = await chrome.downloads.search({id: delta.id, limit: 1});
    if (items && items.length > 0) {
      const item = items[0];
      if (item.url && (item.url.includes('douyin') || item.url.includes('doubao') || item.mime?.includes('video') || item.mime?.includes('mp4'))) {
        try {
          await fetch(`${SERVER}/api/video/external`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              videoUrl: item.url,
              filename: item.filename,
              mime: item.mime
            })
          });
          console.log('[Bridge] Sent video URL:', item.url.substring(0, 60));
        } catch (e) {}
      }
    }
  }
});

// Use chrome.alarms for reliable periodic polling (Manifest V3)
chrome.alarms.create('pollTasks', { periodInMinutes: 0.0833 }); // Every 5 seconds
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollTasks') {
    pollForTasks();
  }
});

// Also start immediately
pollForTasks();
console.log('[Bridge] Started, polling with alarms');