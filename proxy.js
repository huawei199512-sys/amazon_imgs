const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch { /* 可选依赖 */ }

// 已验证代理种子（运维侧可写入 proxy_seed.json，数组格式；不存在则忽略）
const SEED_FILE = path.join(__dirname, 'proxy_seed.json');
function loadSeeds() {
  try {
    const arr = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : [];
  } catch { return []; }
}

// 代理源：HTTP/HTTPS + SOCKS4/SOCKS5 多协议（硬约束：多协议轮换）
const SOURCES = [
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all', prefix: '' },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all', prefix: 'socks5://' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', prefix: '' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt', prefix: 'socks5://' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt', prefix: 'socks4://' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', prefix: '' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', prefix: 'socks5://' },
  { url: 'https://openproxylist.xyz/http.txt', prefix: '' },
  { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', prefix: '' },
  { url: 'https://free-proxy-list.net/', prefix: '', html: true },
];

class ProxyManager {
  constructor() {
    this.knownGoodProxies = loadSeeds();
    this.proxies = [];
    this.badProxies = new Map(); // proxy -> 时间戳
    this.failCount = new Map();  // proxy -> 近期失败次数
    this.enabled = true;         // 强制代理，不允许关闭、不回退直连
    this.maxUsesPerProxy = 5;    // 单代理最多5次必须轮换
    this.usedCount = new Map();
    this.lastRefreshTime = 0;
    this.refreshInterval = 30;   // 秒
    this.badProxyTTL = 60;       // 坏代理1分钟后可重试
    this.proxyIndex = 0;
  }

  setEnabled(v) { this.enabled = true; } // 强制常开
  isEnabled() { return this.enabled; }

  getStatus() {
    return {
      proxy_enabled: this.enabled,
      proxy_count: this.proxies.length,
      known_good_count: this.knownGoodProxies.length,
      bad_proxy_count: this.badProxies.size,
      max_uses_per_proxy: this.maxUsesPerProxy,
      mode: '纯代理模式（强制，不回退直连）',
    };
  }

  createAgent(proxy) {
    if ((proxy.startsWith('socks5://') || proxy.startsWith('socks4://')) && SocksProxyAgent) {
      return new SocksProxyAgent(proxy);
    }
    if (proxy.startsWith('socks')) {
      // 无SOCKS依赖时给一个必失败agent，绝不回退直连
      return new HttpsProxyAgent('http://0.0.0.0:1');
    }
    return new HttpsProxyAgent(proxy.startsWith('http') ? proxy : `http://${proxy}`);
  }

  getRandomUA(mobile = false) {
    if (mobile) {
      return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
    }
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }

  async fetchProxies() {
    const all = new Set();
    const results = await Promise.allSettled(SOURCES.map(async (s) => {
      const resp = await axios.get(s.url, {
        timeout: 8000,
        headers: { 'User-Agent': this.getRandomUA() },
      });
      if (s.html) {
        return String(resp.data).match(/\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}/g) || [];
      }
      return String(resp.data).split('\n').map(l => l.trim()).filter(Boolean).map(p => s.prefix + p);
    }));
    let sourceCount = 0;
    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length) {
        sourceCount++;
        r.value.forEach(p => all.add(p));
      }
    });
    this.knownGoodProxies.forEach(p => all.add(p));
    console.log(`[Proxy] 从 ${sourceCount}/${SOURCES.length} 个源获取到 ${all.size} 个代理`);
    return Array.from(all);
  }

  // 注意：绝不在单次请求的代理轮换循环内调用（源拉取耗时会吃掉60s总预算）
  async refreshProxies(force = false) {
    const now = Date.now() / 1000;
    if (!force && now - this.lastRefreshTime < this.refreshInterval && this.proxies.length > 0) {
      return this.proxies;
    }
    try {
      const keep = this.proxies.filter(p => !this.badProxies.has(p));
      const fresh = await this.fetchProxies();
      const merged = [...new Set([...this.knownGoodProxies, ...keep, ...fresh])]
        .filter(p => !this.badProxies.has(p));
      this.proxies = merged.length ? merged : [...this.knownGoodProxies];
      this.usedCount.clear();
      this.lastRefreshTime = now;
      console.log(`[Proxy] 刷新完成: ${this.proxies.length} 个代理`);
      return this.proxies;
    } catch (e) {
      console.error('[Proxy] 刷新失败:', e.message);
      this.proxies = [...this.knownGoodProxies];
      return this.proxies;
    }
  }

  getProxy() {
    if (!this.enabled) return null;
    const now = Date.now();
    this.badProxies.forEach((ts, p) => {
      if (typeof ts === 'number' && now - ts > this.badProxyTTL * 1000) {
        this.badProxies.delete(p);
        this.failCount.delete(p);
      }
    });

    // 优先：近期无连续失败的已知好代理（knownGood 放宽容额 15 次，偶发失败也不降级）
    const knownGoodLimit = 15;
    const preferred = this.knownGoodProxies.filter(p =>
      !this.badProxies.has(p) && (this.failCount.get(p) || 0) < 3 && (this.usedCount.get(p) || 0) < knownGoodLimit);
    if (preferred.length) {
      const p = preferred[Math.floor(Math.random() * preferred.length)];
      this.usedCount.set(p, (this.usedCount.get(p) || 0) + 1);
      return p;
    }

    // 主力：大代理池轮询
    const available = this.proxies.filter(p =>
      !this.badProxies.has(p) && !this.knownGoodProxies.includes(p) && (this.usedCount.get(p) || 0) < this.maxUsesPerProxy);
    if (available.length) {
      this.proxyIndex = (this.proxyIndex + 1) % available.length;
      const p = available[this.proxyIndex];
      this.usedCount.set(p, (this.usedCount.get(p) || 0) + 1);
      return p;
    }

    // 兜底：重置计数继续轮换，仍无代理才返回null（调用方按失败处理，绝不直连）
    if (this.proxies.length) {
      const nonBad = this.proxies.filter(p => !this.badProxies.has(p));
      if (nonBad.length) {
        this.usedCount.clear();
        this.proxyIndex = (this.proxyIndex + 1) % nonBad.length;
        const p = nonBad[this.proxyIndex];
        this.usedCount.set(p, 1);
        return p;
      }
    }
    if (this.knownGoodProxies.length) {
      const p = this.knownGoodProxies[Math.floor(Math.random() * this.knownGoodProxies.length)];
      this.badProxies.delete(p);
      this.failCount.delete(p);
      return p;
    }
    return null;
  }

  // 会话内已持有代理，继续占用 n 次配额（预热/取token/上传须同IP同cookie）
  noteUses(proxy, n = 1) {
    const cur = this.usedCount.get(proxy) || 0;
    this.usedCount.set(proxy, cur + n);
  }

  // 运行期热注入已验证代理（运维接口）
  addSeeds(list) {
    let added = 0;
    for (const p of list) {
      if (typeof p !== 'string') continue;
      if (!this.knownGoodProxies.includes(p) && this.knownGoodProxies.length < 20) {
        this.knownGoodProxies.push(p); added++;
      }
      this.badProxies.delete(p);
      this.failCount.delete(p);
      this.usedCount.delete(p);
      if (!this.proxies.includes(p)) this.proxies.push(p);
    }
    if (added) this.persistSeeds();
    return { added, total: this.knownGoodProxies.length };
  }

  markFailed(proxy) {
    const n = (this.failCount.get(proxy) || 0) + 1;
    if (this.knownGoodProxies.includes(proxy)) {
      // 已知好代理：失败3次后冷却1分钟
      if (n >= 3) {
        this.badProxies.set(proxy, Date.now());
        this.failCount.set(proxy, 0);
      } else {
        this.failCount.set(proxy, n);
      }
    } else {
      // 其他代理：失败1次即淘汰
      this.badProxies.set(proxy, Date.now());
      this.proxies = this.proxies.filter(p => p !== proxy);
      this.usedCount.delete(proxy);
    }
  }

  markSuccess(proxy) {
    this.failCount.delete(proxy);
    this.badProxies.delete(proxy);
    // 动态学习：成功代理加入已知好代理（上限20个），并落盘为种子
    if (!this.knownGoodProxies.includes(proxy) && this.knownGoodProxies.length < 20) {
      this.knownGoodProxies.push(proxy);
      this.persistSeeds();
      console.log(`[Proxy] ${proxy} 成功，加入已知好代理 (共${this.knownGoodProxies.length}个)`);
    }
  }

  persistSeeds() {
    clearTimeout(this._seedTimer);
    this._seedTimer = setTimeout(() => {
      try { fs.writeFileSync(SEED_FILE, JSON.stringify(this.knownGoodProxies, null, 2)); }
      catch { /* 种子落盘失败不影响主流程 */ }
    }, 2000);
    this._seedTimer.unref && this._seedTimer.unref();
  }
}

module.exports = new ProxyManager();
