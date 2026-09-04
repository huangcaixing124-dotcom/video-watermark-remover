#!/usr/bin/env node
/**
 * cookie_splitter.js — 把浏览器一起导出的混合 cookies 拆成各平台独立 Netscape 文件。
 *
 * 用法：
 *   node cookie_splitter.js <输入的cookies文件路径>
 *
 * 输入：Cookie-Editor 导出的整份 Netscape cookies（含 douyin/kuaishou/doubao/
 *       xiaohongshu/weibo/bilibili 等所有平台域）。
 * 输出：按平台拆分后写到 server/config/<platform>_cookies.txt（只含该域的行）。
 *       B站已用 server/config/bilibili_cookies.txt，脚本会一并更新它。
 *
 * 兼容 B站现有独立文件：若输入里没有 bilibili 域，则保留已有的 bilibili_cookies.txt。
 */
const fs = require('fs');
const path = require('path');

// 平台 → 主机关键字列表（含主域 + 常见子域/跳转域）。行匹配任一即归属该平台。
const PLATFORMS = {
  douyin:      ['.douyin.com', 'iesdouyin.com', 'douyinpic.com'],
  kuaishou:    ['.kuaishou.com', 'gifshow.com', '.www.kuaishou.com'],
  doubao:      ['.doubao.com', '.www.doubao.com'],
  xiaohongshu: ['.xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  weibo:       ['.weibo.com', '.weibo.cn', '.passport.weibo.com'],
  bilibili:    ['.bilibili.com', '.bilibili.cn', '.biligame.com'],
};

const CONFIG_DIR = path.join(__dirname, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

function platformForHost(host) {
  for (const [plat, kws] of Object.entries(PLATFORMS)) {
    for (const kw of kws) {
      if (host.includes(kw)) return plat;
    }
  }
  return null; // 其它域（噪音），忽略
}

function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.error('用法: node cookie_splitter.js <导出的cookies文件路径>');
    process.exit(1);
  }

  const lines = fs.readFileSync(input, 'utf-8').split('\n');
  // bucket[platform] = 规范后的行数组
  const buckets = {};
  for (const p of Object.keys(PLATFORMS)) buckets[p] = [];

  let headerDedup = false;
  let skipped = 0, total = 0;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      // Netscape 的 HttpOnly 行以 "#HttpOnly_域名" 开头，是真实的 cookie（非注释），必须保留。
      const h = line.startsWith('#HttpOnly_');
      if (!h) {
        // 真正的注释（分隔头），只写一次表头。
        if (!headerDedup) { for (const p of Object.keys(PLATFORMS)) buckets[p].push('# Netscape HTTP Cookie File\n# Generated per-platform by cookie_splitter.js\n'); headerDedup = true; }
        continue;
      }
    }
    const parts = line.split('\t');
    // Netscape: domain, includeSub, path, secure, expiry, name, value
    if (parts.length < 7) { skipped++; continue; } // 跳过坏行
    // HttpOnly 行 domain 以 "#HttpOnly_" 前缀开头，检测平台时去掉前缀（输出仍保留原始行）。
    const host = parts[0].replace(/^#HttpOnly_/, '');
    const plat = platformForHost(host);
    if (!plat) { skipped++; continue; }
    total++;
    buckets[plat].push(line);
  }

  const force = process.argv.includes('--force');
  let wrote = 0, keptExisting = 0;
  for (const [plat, rows] of Object.entries(buckets)) {
    if (rows.length <= 1) continue; // 只有表头说明没有该平台的 cookie，跳过（保留既有文件）
    const outPath = path.join(CONFIG_DIR, `${plat}_cookies.txt`);
    // 安全保护：默认不覆盖已有文件，避免误清平台登录态；显式 --force 才覆盖。
    if (fs.existsSync(outPath) && !force) {
      keptExisting++;
      console.log(`· ${plat}: 文件已存在（${plat}_cookies.txt），未覆盖。如需更新用 --force`);
      continue;
    }
    fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf-8');
    wrote++;
    console.log(`✓ ${plat}: ${rows.length - 1} 行 → ${plat}_cookies.txt`);
  }

  console.log(`\n完成：识别 ${total} 个 cookies，写入 ${wrote}、保留既有 ${keptExisting}（跳过 ${skipped} 行噪音/坏行）。`);
}

main();
