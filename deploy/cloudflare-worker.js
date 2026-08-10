/**
 * 去水印视频工具 - 自动负载均衡 + 故障转移 Worker
 *
 * 两台服务器都开着时：基于 URL 哈希分配
 * 一台挂了时：自动故障转移
 * 每次请求实时探测，无缓存，避免多实例不一致
 */
const SERVERS = [
  { name: 'Windows', url: 'https://main.api.hcxserver.xyz' },
  { name: 'MacBook', url: 'https://api-backup.hcxserver.xyz' },
];

const TIMEOUT = 15000; // 转发超时 15 秒

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/api/health') {
      const status = {};
      for (const s of SERVERS) {
        status[s.name] = await probe(s.url + '/api/health') ? 'online' : 'offline';
      }
      return new Response(JSON.stringify({ status: 'ok', servers: status }, null, 2),
        { headers: { 'Content-Type': 'application/json' } });
    }

    // 选择后端（实时探测，无缓存）
    const backend = await selectBackend(url);
    if (!backend) {
      return new Response(JSON.stringify({ error: '所有服务器均不可用' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }

    // 转发请求
    const target = backend.url + url.pathname + url.search;
    try {
      const resp = await fetch(target, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
        timeout: TIMEOUT,
      });
      return new Response(resp.body, {
        status: resp.status, statusText: resp.statusText, headers: resp.headers,
      });
    } catch (err) {
      // 当前后端失败，尝试另一个
      const fallback = SERVERS.find(s => s.url !== backend.url);
      if (!fallback) return new Response(JSON.stringify({ error: '转发失败，无可用备用' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });

      try {
        const fallbackTarget = fallback.url + url.pathname + url.search;
        const resp = await fetch(fallbackTarget, {
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

async function selectBackend(url) {
  // 并行探测所有服务器
  const results = await Promise.all(SERVERS.map(s => probe(s.url + '/api/health')));
  const online = SERVERS.map((s, i) => results[i] ? i : -1).filter(i => i >= 0);

  if (online.length === 0) return null;
  if (online.length === 1) return SERVERS[online[0]];

  // 多台在线 → URL 哈希分配
  const hash = hashCode(url.pathname + url.search);
  return SERVERS[online[hash % online.length]];
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
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