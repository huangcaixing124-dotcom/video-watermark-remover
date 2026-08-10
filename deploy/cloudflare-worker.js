/**
 * 去水印视频工具 - 自动负载均衡 + 故障转移 Worker
 *
 * 两台服务器都开着时：
 *   基于视频 URL 哈希分配，每条链接固定在一台服务器上
 *   不会出现"Windows 创建的任务，MacBook 轮询不到"的问题
 *
 * 一台挂了时：
 *   自动切换到另一台，5 分钟探测一次恢复情况
 */

const SERVERS = [
  { name: 'Windows', url: 'https://main.api.hcxserver.xyz' },
  { name: 'MacBook', url: 'https://api-backup.hcxserver.xyz' },
];

const TIMEOUT   = 15000; // 转发超时 15 秒
const PROBE_TTL = 300000; // 健康状态缓存 5 分钟

// ── 健康状态缓存 ─────────────────────────────────
let serverStatus = SERVERS.map(() => true);
let statusExpires = 0;

/** 探测所有服务器状态 */
async function probeAll() {
  const now = Date.now();
  if (now < statusExpires) return; // 缓存有效

  serverStatus = await Promise.all(SERVERS.map(s => probe(s.url + '/api/health')));
  statusExpires = now + PROBE_TTL;

  const summary = SERVERS.map((s, i) => `${s.name}=${serverStatus[i] ? 'online' : 'offline'}`).join(', ');
  console.log(`[health] ${summary}`);
}

/** 选择一个可用的后端服务器 */
async function selectBackend(url) {
  await probeAll();

  const online = SERVERS.map((s, i) => serverStatus[i] ? i : -1).filter(i => i >= 0);

  if (online.length === 0) return null; // 全部离线
  if (online.length === 1) return SERVERS[online[0]]; // 只剩一台

  // 两台都在线 → 基于 URL 哈希分配
  const hash = hashCode(url.pathname + url.search + (url.method === 'POST' ? (url.body || '') : ''));
  return SERVERS[online[hash % online.length]];
}

// ── 主入口 ───────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查端点
    if (url.pathname === '/api/health') {
      await probeAll();
      const status = {};
      SERVERS.forEach((s, i) => status[s.name] = serverStatus[i] ? 'online' : 'offline');
      return new Response(JSON.stringify({ status: 'ok', servers: status }, null, 2),
        { headers: { 'Content-Type': 'application/json' } });
    }

    // 选择后端
    const backend = await selectBackend(url);
    if (!backend) {
      return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }

    // 转发请求
    const target = backend.url + url.pathname + url.search;
    const req = new Request(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    });

    try {
      const resp = await fetch(req, { timeout: TIMEOUT });
      return new Response(resp.body, {
        status: resp.status, statusText: resp.statusText, headers: resp.headers,
      });
    } catch (err) {
      // 当前后端挂了，标记失效，尝试另一个
      const idx = SERVERS.indexOf(backend);
      if (idx >= 0) { serverStatus[idx] = false; statusExpires = 0; }

      const fallback = SERVERS.find((s, i) => serverStatus[i]);
      if (!fallback) {
        return new Response(JSON.stringify({ error: '转发失败，所有服务器不可用' }), {
          status: 502, headers: { 'Content-Type': 'application/json' },
        });
      }

      const fallbackTarget = fallback.url + url.pathname + url.search;
      const fallbackReq = new Request(fallbackTarget, {
        method: request.method, headers: request.headers, body: req.body,
      });
      const resp = await fetch(fallbackReq, { timeout: TIMEOUT });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    }
  },
};

// ── 工具函数 ─────────────────────────────────────
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

async function probe(url) {
  try {
    const resp = await fetch(url, { method: 'GET', timeout: 3000 });
    return resp.ok;
  } catch { return false; }
}