/**
 * 去水印视频工具 - 自动负载均衡 + 故障转移 Worker
 *
 * 两台服务器都开着时：基于视频 URL 哈希分配
 * 一台挂了时：自动故障转移
 * 每次请求实时探测，无缓存
 *
 * 注意：
 * - 视频 API 请求（/api/video/*）是有状态的，同一任务必须路由到同一台服务器
 * - 快手/豆包依赖桥接扩展（仅 Windows 有），强制路由到 Windows
 * - 其他平台（YouTube、B站等）正常负载均衡
 */
const SERVERS = [
  { name: 'Windows', url: 'https://main.api.hcxserver.xyz' },
  { name: 'MacBook', url: 'https://api-backup.hcxserver.xyz' },
];

const TIMEOUT = 15000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      const status = {};
      for (const s of SERVERS) {
        status[s.name] = await probe(s.url + '/api/health') ? 'online' : 'offline';
      }
      return new Response(JSON.stringify({ status: 'ok', servers: status }, null, 2),
        { headers: { 'Content-Type': 'application/json' } });
    }

    const backend = await selectBackend(request, url);
    if (!backend) {
      return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }

    const target = backend.url + path + url.search;
    try {
      const resp = await fetch(target, {
        method: request.method, headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
        timeout: TIMEOUT,
      });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (err) {
      const fallback = SERVERS.find(s => s.url !== backend.url);
      if (!fallback) {
        return new Response(JSON.stringify({ error: '转发失败，无可用备用' }), {
          status: 502, headers: { 'Content-Type': 'application/json' },
        });
      }
      try {
        const resp = await fetch(fallback.url + path + url.search, {
          method: request.method, headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
          timeout: TIMEOUT,
        });
        return new Response(resp.body, { status: resp.status, headers: resp.headers });
      } catch {
        return new Response(JSON.stringify({ error: '转发失败，所有服务器不可用' }), {
          status: 502, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  },
};

async function selectBackend(request, url) {
  const results = await Promise.all(SERVERS.map(s => probe(s.url + '/api/health')));
  const online = SERVERS.map((s, i) => results[i] ? i : -1).filter(i => i >= 0);

  if (online.length === 0) return null;
  if (online.length === 1) return SERVERS[online[0]];

  const hashKey = await extractHashKey(request, url);

  // 快手/豆包强制走 Windows（桥接扩展仅 Windows 有）
  if (hashKey === 'bridge-required') {
    if (results[0]) return SERVERS[0];     // Windows 在线 → 走 Windows
    return SERVERS[online[0]];              // Windows 不在线 → 走其他（降级）
  }

  // 任务 ID 前缀路由：任务 ID 以 "0" 开头 → Windows，以 "1" 开头 → MacBook
  // 服务器端的 generateId() 会 prepend SERVER_ID（0或1）
  if (hashKey === 'task-id') {
    const taskId = await extractTaskId(request, url);
    if (taskId) {
      const idx = taskId.startsWith('0') ? 0 : taskId.startsWith('1') ? 1 : -1;
      if (idx >= 0 && results[idx]) return SERVERS[idx];
      if (idx >= 0) return SERVERS[online[0]]; // 目标服务器不在线，用其他在线
    }
  }

  const hash = hashCode(hashKey);
  return SERVERS[online[hash % online.length]];
}

async function extractHashKey(request, url) {
  const path = url.pathname;

  if (path === '/api/video/info' && request.method === 'POST') {
    try {
      const body = await request.clone().json();
      if (body.url) {
        if (body.url.includes('kuaishou.com') || body.url.includes('doubao.com') || body.url.includes('gifshow.com')) {
          return 'bridge-required';
        }
        return body.url;
      }
    } catch {}
  }

  const taskMatch = path.match(/\/api\/video\/(?:task|file)\/(.+)/);
  if (taskMatch) return 'task-id';

  return path + url.search;
}

/** 从 task/file 请求中提取任务 ID */
async function extractTaskId(request, url) {
  const match = url.pathname.match(/\/api\/video\/(?:task|file)\/(.+)/);
  if (match) return match[1];
  return null;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0;
  }
  return Math.abs(hash);
}

async function probe(url) {
  try {
    const resp = await fetch(url, { method: 'GET', timeout: 3000 });
    return resp.ok;
  } catch { return false; }
}