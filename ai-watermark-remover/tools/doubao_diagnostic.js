/**
 * 豆包去水印诊断工具
 *
 * 在豆包页面 (www.doubao.com) 的开发者控制台中运行：
 *   1. 打开浏览器开发者工具 (F12)
 *   2. 粘贴本文件内容并执行
 *   3. 查看诊断结果
 *
 * 或者直接使用诊断面板：
 *   在控制台输入: doubaoDiag.run()
 */

const doubaoDiag = (function() {
  'use strict';

  const LOG = '[豆包诊断]';

  // ========== 1. 检查 _ROUTER_DATA ==========
  function checkRouterData() {
    console.log(`${LOG} ===== 1. 检查 _ROUTER_DATA =====`);
    const rd = window._ROUTER_DATA;
    if (!rd) {
      console.error(`${LOG} ❌ _ROUTER_DATA 不存在！`);
      return { found: false, error: '_ROUTER_DATA 不存在' };
    }
    console.log(`${LOG} ✅ _ROUTER_DATA 存在`);

    // 检查各个路径
    const paths = [
      'loaderData.chat_layout.trimmedChainRecentConvCells',
      'loaderData.chat_layout.convCells',
      'loaderData.chat_layout.recentConvCells',
      'loaderData.chat_layout.cells',
      'loaderData.conversation.messages',
      'loaderData.messages',
    ];

    let foundVideos = false;
    for (const p of paths) {
      try {
        const val = p.split('.').reduce((o, k) => o?.[k], rd);
        if (val) {
          const arr = Array.isArray(val) ? val : [val];
          console.log(`${LOG}   路径 "${p}": ${arr.length} 条`);
          if (arr.length > 0) foundVideos = true;
        } else {
          console.log(`${LOG}   路径 "${p}": 空`);
        }
      } catch (e) {
        console.log(`${LOG}   路径 "${p}": 错误 - ${e.message}`);
      }
    }

    // 检查是否有 vid 以 v0 开头的
    try {
      const json = JSON.stringify(rd);
      const vids = json.match(/"v0[a-zA-Z0-9_]+"/g);
      if (vids) {
        const unique = [...new Set(vids)];
        console.log(`${LOG} ✅ 找到 ${unique.length} 个 vid:`, unique.slice(0, 5));
        foundVideos = true;
      }
    } catch {}

    return { found: foundVideos, routerData: rd };
  }

  // ========== 2. 检查 videoCache ==========
  function checkVideoCache() {
    console.log(`${LOG} ===== 2. 检查 videoCache =====`);
    // 通过消息监听获取 content.js 的缓存状态
    // 实际上 videoCache 在 MAIN world 中，无法直接访问
    // 但我们可以尝试通过 postMessage 通信
    return new Promise((resolve) => {
      const handler = (ev) => {
        if (ev.data && ev.data.type === 'diagCacheResult') {
          window.removeEventListener('message', handler);
          resolve(ev.data.data);
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'diagGetCache' }, '*');
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ error: '超时 - content.js 可能未加载或未响应' });
      }, 2000);
    });
  }

  // ========== 3. 测试 get_play_info API ==========
  async function testGetPlayInfo(vid) {
    console.log(`${LOG} ===== 3. 测试 get_play_info API =====`);
    if (!vid) {
      console.log(`${LOG} ⚠️ 未提供 vid，跳过 API 测试`);
      return { tested: false };
    }

    const endpoints = [
      { url: 'https://www.doubao.com/samantha/media/get_play_info', type: 'video' },
      { url: 'https://www.doubao.com/samantha/media/get_play_info', type: 'video_gen' },
      { url: 'https://www.doubao.com/creativity/video/get_play_info', type: 'video' },
    ];

    for (const ep of endpoints) {
      try {
        const params = new URLSearchParams({
          aid: '497858',
          device_platform: 'web',
          samantha_web: '1',
          'use-olympus-account': '1',
          version_code: '20800',
          pkg_type: 'release_version',
          web_tab_id: crypto.randomUUID()
        });
        const url = `${ep.url}?${params.toString()}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'agw-js-conv': 'str',
            'origin': location.origin,
            'referer': location.href
          },
          credentials: 'include',
          body: JSON.stringify({ key: vid, type: ep.type })
        });

        const json = await response.json();
        console.log(`${LOG}   端点 ${ep.url.substring(0, 60)}... type=${ep.type}`);
        console.log(`${LOG}   状态码: ${response.status}, code: ${json.code}`);

        if (json.code === 0 && json.data) {
          console.log(`${LOG}   ✅ API 成功!`);
          // 检查是否有视频地址
          const hasOriginalMedia = !!json.data.original_media_info?.main_url;
          const hasPlayInfos = !!(json.data.play_infos?.length > 0 && json.data.play_infos[0].main);
          const hasMediaInfo = !!(json.data.media_info?.length > 0 && json.data.media_info[0].main_url);
          console.log(`${LOG}   original_media_info: ${hasOriginalMedia ? '✅' : '❌'}`);
          console.log(`${LOG}   play_infos: ${hasPlayInfos ? '✅' : '❌'}`);
          console.log(`${LOG}   media_info: ${hasMediaInfo ? '✅' : '❌'}`);
          if (hasOriginalMedia) {
            console.log(`${LOG}   main_url: ${json.data.original_media_info.main_url.substring(0, 80)}...`);
          }
          return { success: true, data: json.data, endpoint: ep.url };
        } else {
          console.log(`${LOG}   ❌ API 返回错误: ${json.msg || json.message || '未知'}`);
        }
      } catch (e) {
        console.log(`${LOG}   ❌ 请求失败: ${e.message}`);
      }
    }

    return { success: false, error: '所有端点均失败' };
  }

  // ========== 4. 检查 DOM 中的视频元素 ==========
  function checkDOM() {
    console.log(`${LOG} ===== 4. 检查 DOM =====`);
    const videos = document.querySelectorAll('video');
    console.log(`${LOG}   找到 ${videos.length} 个 video 元素`);
    videos.forEach((v, i) => {
      console.log(`${LOG}     video[${i}]: src=${(v.currentSrc || v.src || '').substring(0, 80)}, width=${v.videoWidth}, height=${v.videoHeight}`);
    });

    const downloadButtons = document.querySelectorAll('.doubao-dl-btn');
    console.log(`${LOG}   找到 ${downloadButtons.length} 个下载按钮`);
    downloadButtons.forEach((b, i) => {
      console.log(`${LOG}     btn[${i}]: disabled=${b.disabled}, classes=${b.className}`);
    });

    return { videoCount: videos.length, buttonCount: downloadButtons.length };
  }

  // ========== 5. 检查 fetch 劫持状态 ==========
  function checkFetchHijack() {
    console.log(`${LOG} ===== 5. 检查 fetch 劫持 =====`);
    const isFetchHijacked = window.fetch.toString().includes('_doubaoUrl') || window.fetch.toString().includes('chat/completion');
    console.log(`${LOG}   fetch 已劫持: ${isFetchHijacked ? '✅' : '❌'}`);
    const isXHRHijacked = XMLHttpRequest.prototype.open.toString().includes('_doubaoUrl');
    console.log(`${LOG}   XHR 已劫持: ${isXHRHijacked ? '✅' : '❌'}`);
    return { fetch: isFetchHijacked, xhr: isXHRHijacked };
  }

  // ========== 主入口 ==========
  async function run() {
    console.log(`%c${LOG} 豆包去水印诊断工具 v1.0`, 'font-size:16px;font-weight:bold;color:#5aaaff;');
    console.log(`${LOG} 开始诊断...`);

    const results = {};

    // 1. Router Data
    results.routerData = checkRouterData();

    // 2. Fetch Hijack
    results.hijack = checkFetchHijack();

    // 3. DOM
    results.dom = checkDOM();

    // 4. API 测试（需要先找到 vid）
    if (results.routerData.found) {
      try {
        const json = JSON.stringify(results.routerData.routerData);
        const match = json.match(/"v0[a-zA-Z0-9_]+"/);
        if (match) {
          const vid = match[0].replace(/"/g, '');
          console.log(`${LOG} 使用 vid: ${vid} 测试 API`);
          results.api = await testGetPlayInfo(vid);
        }
      } catch {}
    }

    // 5. videoCache
    results.cache = await checkVideoCache();

    // 汇总
    console.log(`%c${LOG} ===== 诊断完成 =====`, 'font-size:14px;font-weight:bold;');
    console.log(`${LOG} _ROUTER_DATA: ${results.routerData.found ? '✅' : '❌'}`);
    console.log(`${LOG} fetch/XHR 劫持: ${results.hijack.fetch && results.hijack.xhr ? '✅' : '❌'}`);
    console.log(`${LOG} DOM 视频元素: ${results.dom.videoCount > 0 ? '✅' : '❌'}`);
    console.log(`${LOG} 下载按钮: ${results.dom.buttonCount > 0 ? '✅' : '❌'}`);
    console.log(`${LOG} API 测试: ${results.api?.success ? '✅' : '❌'}`);

    if (!results.routerData.found) {
      console.warn(`${LOG} 💡 建议: 检查豆包页面是否已加载视频，尝试刷新页面`);
    }
    if (!results.api?.success) {
      console.warn(`${LOG} 💡 建议: 登录状态可能已过期，尝试重新登录豆包`);
    }

    return results;
  }

  return { run };
})();

// 自动导出到全局
if (typeof window !== 'undefined') {
  window.doubaoDiag = doubaoDiag;
  console.log('%c[豆包诊断] 诊断工具已加载。在控制台输入 doubaoDiag.run() 运行诊断', 'color:#5aaaff;font-weight:bold;');
}