const proxyManager = require('./proxy');
const { curlRequest } = require('./curlClient');

// ============ 图片输入安全 ============
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MIN_IMAGE_BYTES = 1024;            // 1KB
const ALLOWED_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// 魔数嗅探：不信任前端声明的Content-Type / 扩展名
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // WEBP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function normalizeImageInput(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return { error: 'image 参数必填（data:image base64 或 http(s) 图片URL）' };
  }
  image = image.trim();

  if (/^https?:\/\//i.test(image)) {
    const block = isBlockedHost(image);
    if (block) return { error: block };
    return { type: 'url', url: image };
  }

  let b64 = image;
  const m = image.match(/^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)?;base64,(.+)$/s);
  if (m) {
    if (m[1] && !ALLOWED_MIME[m[1]]) return { error: `不支持的图片类型: ${m[1]}，仅允许 jpeg/png/webp` };
    b64 = m[2];
  }
  b64 = b64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(b64)) return { error: 'base64 数据含非法字符' };

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'base64 解码失败' };
  }
  if (buf.length < MIN_IMAGE_BYTES) return { error: '图片过小（至少1KB）' };
  if (buf.length > MAX_IMAGE_BYTES) return { error: '图片过大（最大5MB）' };
  const mime = sniffImage(buf);
  if (!mime) return { error: '文件魔数校验失败：不是有效的 jpeg/png/webp 图片' };
  return { type: 'buffer', buffer: buf, mime };
}

// SSRF 防护：禁止把内网/元数据地址当作图片URL交给服务端
function isBlockedHost(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '图片URL格式非法';
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return '禁止访问内网主机名';
  }
  const ipParts = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipParts) {
    const a = parseInt(ipParts[1], 10);
    const b = parseInt(ipParts[2], 10);
    const parts = ipParts.slice(1).map(Number);
    if (parts.some(n => n > 255)) return '图片URL中的IP非法';
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224) {
      return '禁止访问内网/保留/链路本地地址';
    }
  }
  return null;
}

// ============ robots.txt 协议（实时拉取+1小时缓存，全程走代理）============
const robotsCache = new Map(); // domain -> { ts, disallows }
const ROBOTS_TTL = 3600 * 1000;

// 本服务只会访问的业务路径白名单（已对照当前 robots.txt 核实未被 User-agent:* 禁止）
const FALLBACK_ALLOWED_PREFIXES = ['/images/SearchByImage/', '/shopthelook', '/stylesnap', '/s', '/dp/'];

function parseStarDisallows(txt) {
  const dis = [];
  let active = false;
  for (const raw of txt.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (/^user-agent:/i.test(line)) {
      active = line.replace(/^user-agent:\s*/i, '').trim() === '*';
    } else if (active && /^disallow:/i.test(line)) {
      const p = line.replace(/^disallow:\s*/i, '').trim();
      if (p) dis.push(p);
    }
  }
  return dis;
}

function matchDisallow(pathname, pattern) {
  // robots 简易匹配：* 作为通配符，其余正则元字符转义
  const re = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(re).test(pathname);
}

async function assertRobotsAllowed(domain, pathname) {
  const cached = robotsCache.get(domain);
  let disallows = cached && Date.now() - cached.ts < ROBOTS_TTL ? cached.disallows : null;

  if (disallows === null) {
    disallows = await fetchRobotsViaProxy(domain);
    if (disallows) robotsCache.set(domain, { ts: Date.now(), disallows });
  }

  if (disallows) {
    const hit = disallows.find(p => matchDisallow(pathname, p));
    if (hit) {
      const e = new Error(`robots.txt 禁止采集该路径: ${pathname} (Disallow: ${hit})`);
      e.code = 'ROBOTS_DENIED';
      throw e;
    }
    return true;
  }

  // robots 拉取失败：保守策略——仅允许已人工核实的白名单路径
  if (FALLBACK_ALLOWED_PREFIXES.some(p => pathname.startsWith(p))) return true;
  const e = new Error(`robots.txt 无法获取且路径 ${pathname} 不在安全白名单内，本次拒绝采集`);
  e.code = 'ROBOTS_UNKNOWN';
  throw e;
}

async function fetchRobotsViaProxy(domain) {
  // 3个代理并发竞速，首个成功即返回，避免串行超时累积
  const proxies = [];
  for (let i = 0; i < 3; i++) {
    const p = proxyManager.getProxy();
    if (p) proxies.push(p);
  }
  if (!proxies.length) return null;

  const tasks = proxies.map(async proxy => {
    const r = await curlRequest({
      proxy,
      url: `https://${domain}/robots.txt`,
      timeoutMs: 6000,
      followRedirects: true,
      headers: { 'User-Agent': proxyManager.getRandomUA(), 'Accept': 'text/plain,*/*' },
    });
    if (r.ok && r.status === 200) {
      proxyManager.markSuccess(proxy);
      return parseStarDisallows(r.body.toString('utf8'));
    }
    proxyManager.markFailed(proxy);
    return null;
  });

  const results = await Promise.all(tasks);
  return results.find(Boolean) || null;
}

// ============ 客户端限流（人类节奏，默认每IP每分钟12次）============
class RateLimiter {
  constructor(max = 12, windowMs = 60000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => {
      const now = Date.now();
      this.hits.forEach((arr, k) => {
        const recent = arr.filter(t => now - t < this.windowMs);
        if (recent.length) this.hits.set(k, recent);
        else this.hits.delete(k);
      });
    }, 60000).unref();
  }

  check(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (arr.length >= this.max) return false;
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

module.exports = {
  sniffImage,
  normalizeImageInput,
  isBlockedHost,
  assertRobotsAllowed,
  RateLimiter,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_BYTES,
  ALLOWED_MIME,
};
