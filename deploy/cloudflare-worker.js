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
      // 诊断：即时真实 probe 两台（不走缓存），用于确认 Worker 眼里 Mac 的真实可达性
      const fresh = [];
      for (const s of SERVERS) fresh.push({ name: s.name, probeUrl: s.url + '/api/health', ok: await probe(s.url + '/api/health') });
      const status = {};
      fresh.forEach(f => status[f.name] = f.ok ? 'online' : 'offline');
      ctx.waitUntil(refreshHealth());
      return new Response(JSON.stringify({ status: 'ok', __v: '3-diag', servers: status, probes: fresh }, null, 2),
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

  // 任务 ID 前缀路由：0开头→Windows，1开头→MacBook（任务始终回到创建它的服务器）
  if (hashKey === 'task-id') {
    const id = url.pathname.match(/\/api\/(?:video\/(?:task|file)|transcript\/(?:task|text|srt))\/(.+)/)?.[1] || '';
    const idx = id.startsWith('0') ? 0 : id.startsWith('1') ? 1 : -1;
    if (idx >= 0 && statusArr[idx]) return SERVERS[idx];
    if (idx >= 0) return onlineServers[0];
  }

  // 普通请求：优先 Windows（主），Mac 仅当 Windows 不在线时降级使用。
  // 满足「Mac 关闭时任务回落到 Windows 本机」：Windows online 时绝不把流量分给 Mac，
  // 从根本上避免因哈希路由到 Mac(掉线) 而产生的 530/failover 竞态。
  const windows = onlineServers.find(s => s.name === 'Windows');
  if (windows) return windows;

  // Windows 不在线时，只能在存活后端里负载均衡（通常只剩 Mac）
  const hash = hashCode(hashKey);
  return onlineServers[hash % onlineServers.length];
}

/** 转发请求，失败（含后端返回 530/5xx）时切换另一台可用后端。 */
async function forwardWithFailover(request, url, backend) {
  const start = Date.now();
  // 先读 body 为 buffer，供首次转发与 failover 重放（避免 ReadableStream 消耗一次后失效）
  const bodyBuf = ['GET', 'HEAD'].includes(request.method) ? null : await request.clone().arrayBuffer();

  const send = async (base) => fetch(new Request(base + url.pathname + url.search, {
    method: request.method, headers: request.headers, body: bodyBuf,
  }), { timeout: TIMEOUT });

  try {
    const resp = await send(backend.url);
    const ms = Date.now() - start;
    if (ms > 5000) console.log(`[proxy] ${url.pathname} -> ${backend.name} took ${ms}ms`);
    // 关键：后端若返回 530 / 5xx（隧道/网关层故障，如 Mac 掉线返回 Tunnel error 530），
    // 视为该后端不可用，failover 到另一台（如 Mac 关时切 Windows），而不是把 530 透传给用户。
    if (resp.status === 530 || resp.status >= 500) {
      console.log(`[failover] ${backend.name} returned ${resp.status} (${url.pathname}), switching backend`);
      return await failoverToOther(request, url, backend, send);
    }
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch (err) {
    console.log(`[failover] ${backend.name} fetch failed: ${err.message}`);
    return await failoverToOther(request, url, backend, send);
  }
}

/** 标记故障后端离线、强制刷新健康、改发另一台可用后端（优先 Windows）。 */
async function failoverToOther(request, url, failedBackend, send) {
  const fidx = SERVERS.indexOf(failedBackend);
  if (fidx >= 0) serverStatus[fidx] = false;
  healthExpireAt = 0;
  healthRefreshing = false;
  const online = await refreshHealthWithResult(true);
  if (online.length === 0) {
    return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
  // 尽量选一台 ≠ 故障后端 的，且优先 Windows（桥接能力在本机；Mac 关时要落到 Windows）
  const alt = online.find(s => s.name === 'Windows' && s !== failedBackend)
    || online.find(s => s !== failedBackend)
    || online[0];
  try {
    const resp = await send(alt.url);
    console.log(`[failover] now served by ${alt.name} (${url.pathname}) status=${resp.status}`);
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch (e) {
    console.log(`[failover] alt ${alt.name} failed: ${e.message}`);
    return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
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

  // 任务状态轮询类路径：video(task|file) 与 transcript(task|text|srt) 均按 id 前缀粘性路由
  const taskMatch = path.match(/\/api\/(?:video\/(?:task|file)|transcript\/(?:task|text|srt))\/(.+)/);
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