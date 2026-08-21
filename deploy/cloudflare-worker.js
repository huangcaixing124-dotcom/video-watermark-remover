/**
 * 去水印视频工具 - 自动负载均衡 + 故障转移 Worker（带健康缓存）
 *
 * 优化点：
 * - 健康状态缓存：不每次请求实时探测，降低解析延迟
 * - 定时器后台刷新健康状态（不阻塞请求）
 * - 转发失败时主动失效缓存并重试
 *
 * 路由规则不变：
 * - 快手/豆包强制走 Windows（桥接扩展仅 Windows 有）
 * - 视频 API 请求有状态，同一任务路由到同一台服务器
 * - 其他平台 URL 哈希负载均衡
 */
const SERVERS = [
  { name: 'Windows', url: 'https://main.api.hcxserver.xyz' },
  { name: 'MacBook', url: 'https://api-backup.hcxserver.xyz' },
];

const TIMEOUT = 15000;
const HEALTH_TTL = 30000; // 健康缓存 30 秒

// ── 健康状态缓存（进程内）────────────────────────
const serverStatus = SERVERS.map(() => true); // 初始假设全在线
let healthExpireAt = 0;
let healthRefreshing = false;

/** 后台刷新健康状态（不阻塞，通常由定时器调用） */
async function refreshHealth(force = false) {
  const now = Date.now();
  if (!force && now < healthExpireAt) return; // 缓存未过期
  if (healthRefreshing) return; // 已有刷新在进行
  healthRefreshing = true;

  try {
    const results = await Promise.all(SERVERS.map(s =>
      probe(s.url + '/api/health').then(ok => {
        if (!ok) console.log(`[health] ${s.name} offline`);
        return ok;
      }).catch(() => false)
    ));
    results.forEach((ok, i) => serverStatus[i] = ok);
    healthExpireAt = Date.now() + HEALTH_TTL;
    console.log(`[health] ${SERVERS.map((s,i)=>`${s.name}=${serverStatus[i]?'online':'offline'}`).join(', ')}`);
  } finally {
    healthRefreshing = false;
  }
}

/** 强制刷新（转发失败时调用），返回任一可用后端 */
async function refreshAndAwait() {
  return await refreshHealthWithResult(true);
}

async function refreshHealthWithResult(force) {
  if (force) healthExpireAt = 0;
  healthRefreshing = false; // 允许重新探测
  await refreshHealth(force);
  const online = SERVERS.map((s, i) => serverStatus[i] ? i : -1).filter(i => i >= 0);
  return online.map(i => SERVERS[i]);
}

// ── Worker 定时器（每 20 秒后台刷新健康状态）───────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshHealth());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查端点
    if (path === '/api/health') {
      // 使用缓存状态（后台定时刷新）
      ctx.waitUntil(refreshHealth());
      const status = {};
      SERVERS.forEach((s, i) => status[s.name] = serverStatus[i] ? 'online' : 'offline');
      return new Response(JSON.stringify({ status: 'ok', servers: status }, null, 2),
        { headers: { 'Content-Type': 'application/json' } });
    }

    // 非健康检查：确保健康状态新鲜（命中缓存则零等待）
    // 用 ctx.waitUntil 后台刷新，请求直接走缓存，不阻塞
    ctx.waitUntil(refreshHealth());

    // 基于当前缓存状态选后端（无探测，立即返回）
    const online = SERVERS.map((s, i) => serverStatus[i] ? i : -1).filter(i => i >= 0);
    if (online.length === 0) {
      // 全离线：强制刷新一次再试
      await refreshHealth(true);
      const retry = SERVERS.map((s, i) => serverStatus[i] ? i : -1).filter(i => i >= 0);
      if (retry.length === 0) {
        return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const hashKey = await extractHashKey(request, url);
    const backend = routeBackend(url, hashKey, serverStatus);
    if (!backend) {
      return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }

    // 转发请求
    return forwardWithFailover(request, url, backend);
  },
};

/** 纯路由选择（无 IO，立即执行） */
function routeBackend(url, hashKey, statusArr) {
  const online = statusArr.map((ok, i) => ok ? i : -1).filter(i => i >= 0);
  const onlineServers = online.map(i => SERVERS[i]);
  if (onlineServers.length === 0) return null;

  // 快手/豆包强制走 Windows
  if (hashKey === 'bridge-required') {
    return onlineServers.find(s => s.name === 'Windows') || onlineServers[0];
  }

  // 任务 ID 前缀路由：0开头→Windows，1开头→MacBook
  if (hashKey === 'task-id') {
    const id = url.pathname.match(/\/api\/video\/(?:task|file)\/(.+)/)?.[1] || '';
    const idx = id.startsWith('0') ? 0 : id.startsWith('1') ? 1 : -1;
    if (idx >= 0 && statusArr[idx]) return SERVERS[idx];
    if (idx >= 0) return onlineServers[0];
  }

  const hash = hashCode(hashKey);
  return onlineServers[hash % onlineServers.length];
}

/** 转发请求，失败时强制刷新并重试另一台 */
async function forwardWithFailover(request, url, backend) {
  const start = Date.now();
  const target = backend.url + url.pathname + url.search;
  const body = ['GET','HEAD'].includes(request.method) ? null : request.body;

  try {
    const resp = await fetch(target, {
      method: request.method, headers: request.headers, body, timeout: TIMEOUT,
    });
    const ms = Date.now() - start;
    if (ms > 5000) console.log(`[proxy] ${url.pathname} -> ${backend.name} took ${ms}ms`);
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch (err) {
    console.log(`[failover] ${backend.name} failed: ${err.message}`);
    // 当前后端失败，标记离线并强制刷新
    const bidx = SERVERS.indexOf(backend);
    if (bidx >= 0) serverStatus[bidx] = false;
    healthExpireAt = 0;

    // 选另一台在线
    const others = await refreshHealthWithResult(true);
    const fallback = others.find(s => s.url !== backend.url);
    if (!fallback) {
      return new Response(JSON.stringify({ error: '转发失败，无可用备用' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }
    try {
      const resp = await fetch(fallback.url + url.pathname + url.search, {
        method: request.method, headers: request.headers, body, timeout: TIMEOUT,
      });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch {
      return new Response(JSON.stringify({ error: '转发失败，所有服务器不可用' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }
  }
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

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0;
  }
  return Math.abs(hash);
}

async function probe(url) {
  try {
    const resp = await fetch(url, { method: 'GET', timeout: 2000 });
    return resp.ok;
  } catch { return false; }
}