// 代理池管理模块 - 支持HTTP/HTTPS/SOCKS4/SOCKS5多协议
// 针对Amazon优化：25+代理源、预验证机制、激进并发策略
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch { /* 可选依赖 */ }

class ProxyManager {
  constructor() {
    // 已知曾可用的代理（优先使用，由markSuccess动态添加）
    this.knownGoodProxies = [];
    this.proxies = [...this.knownGoodProxies];
    this.badProxies = new Map(); // proxy -> timestamp
    this.enabled = true; // 强制开启代理
    this.maxUsesPerProxy = 3; // 单个代理最多使用3次后轮换（之前1次太激进）
    this.usedCount = new Map();
    this.lastRefreshTime = 0;
    this.refreshInterval = 120; // 2分钟最小刷新间隔
    this.autoRefreshIntervalMs = 5 * 60 * 1000; // 自动刷新间隔：5分钟（比之前更频繁）
    this.badProxyTTL = 30; // 30秒后允许重新尝试坏代理（之前60秒）
    this.proxyIndex = 0; // 轮询索引
    this.autoRefreshTimer = null; // 自动刷新定时器
    this.refreshing = false; // 防止并发刷新
    this.verifiedPool = []; // 已验证可用的代理池（预验证通过）
    this.verifying = false; // 正在验证中
    this.lastVerificationTime = 0;
    this.verificationInterval = 60 * 1000; // 每60秒验证一轮
    this.maxKnownGood = 200; // 最大已知好代理数（之前20）
  }

  // 判断代理协议
  getProxyProtocol(proxy) {
    if (proxy.startsWith('socks5://')) return 'socks5';
    if (proxy.startsWith('socks4://')) return 'socks4';
    if (proxy.startsWith('https://')) return 'https';
    return 'http'; // 默认http
  }

  // 规范化代理字符串（带协议前缀）
  normalizeProxy(proxy) {
    if (proxy.startsWith('socks') || proxy.startsWith('http')) return proxy;
    return `http://${proxy}`; // 默认http
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  getStatus() {
    const httpCount = this.proxies.filter(p => !p.startsWith('socks')).length;
    const socksCount = this.proxies.filter(p => p.startsWith('socks')).length;
    return {
      proxy_enabled: this.enabled,
      proxy_count: this.proxies.length,
      verified_count: this.verifiedPool.length,
      http_count: httpCount,
      socks_count: socksCount,
      known_good_count: this.knownGoodProxies.length,
      bad_proxy_count: this.badProxies.size,
      max_uses_per_proxy: this.maxUsesPerProxy,
      mode: '纯代理模式（强制，不回退直连）',
      auto_refresh: this.getAutoRefreshStatus(),
      proxy_sources: 25,
      refresh_interval_display: `${this.autoRefreshIntervalMs / (60 * 1000)}分钟`,
    };
  }

  createAgent(proxy) {
    const protocol = this.getProxyProtocol(proxy);
    const proxyUrl = this.normalizeProxy(proxy);

    // SOCKS代理
    if (protocol === 'socks5' || protocol === 'socks4') {
      if (SocksProxyAgent) {
        return new SocksProxyAgent(proxyUrl);
      }
      // 无SOCKS依赖时返回一个会失败的agent（保持纯代理模式，不回退直连）
      return new HttpsProxyAgent('http://0.0.0.0:1');
    }

    // HTTP/HTTPS 代理
    return new HttpsProxyAgent(proxyUrl);
  }

  // ============ 代理源获取（25源并发，针对Amazon优化）============

  // 源1：ProxyScrape HTTP
  async fetchFromProxyScrape() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=all';
      const response = await axios.get(url, { timeout: 10000 });
      return response.data.split('\r\n').filter((p) => p && p.includes(':')).map((p) => p.trim());
    } catch { return []; }
  }

  // 源2：Geonode 第1页
  async fetchFromGeonode() {
    try {
      const url = 'https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http';
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data && response.data.data) {
        return response.data.data.map((p) => `${p.ip}:${p.port}`).filter((p) => p && p !== ':');
      }
      return [];
    } catch { return []; }
  }

  // 源3：Geonode 第2页
  async fetchFromGeonodePage2() {
    try {
      const url = 'https://proxylist.geonode.com/api/proxy-list?limit=200&page=2&sort_by=lastChecked&sort_type=desc';
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data && response.data.data) {
        return response.data.data.map((p) => `${p.ip}:${p.port}`).filter((p) => p && p !== ':');
      }
      return [];
    } catch { return []; }
  }

  // 源4：TheSpeedX HTTP
  async fetchFromTheSpeedX() {
    try {
      const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源5：fate0/proxylist
  async fetchFromFreeProxyList() {
    try {
      const url = 'https://raw.githubusercontent.com/fate0/proxylist/master/proxy.list';
      const response = await axios.get(url, { timeout: 15000 });
      const lines = response.data.split('\n').filter(Boolean);
      const result = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.host && obj.port) result.push(`${obj.host}:${obj.port}`);
        } catch { continue; }
      }
      return result.slice(0, 300);
    } catch { return []; }
  }

  // 源6：ProxyScrape SOCKS5
  async fetchFromSocksProxyScrape() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=8000&country=all';
      const response = await axios.get(url, { timeout: 10000 });
      return response.data.split('\r\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`);
    } catch { return []; }
  }

  // 源7：TheSpeedX SOCKS5
  async fetchFromTheSpeedXSocks() {
    try {
      const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源8：jetkai HTTP
  async fetchFromJetkaiHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源9：jetkai SOCKS5
  async fetchFromJetkaiSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 500);
    } catch { return []; }
  }

  // 源10：hookzof SOCKS5
  async fetchFromHookzofSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源11：hubp.de 所有代理
  async fetchFromHubpAll() {
    try {
      const url = 'https://git.hubp.de/iplocate/free-proxy-list/raw/main/all-proxies.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源12：monosans HTTP
  async fetchFromMonosansHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 300);
    } catch { return []; }
  }

  // 源13：monosans SOCKS5
  async fetchFromMonosansSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源14：roosterkid HTTPS
  async fetchFromRoosterkidHttps() {
    try {
      const url = 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源15：roosterkid SOCKS5
  async fetchFromRoosterkidSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源16：ShiftyTR HTTP
  async fetchFromShiftyTRHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源17：ShiftyTR SOCKS5
  async fetchFromShiftyTRSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源18：rdavydov HTTP
  async fetchFromRdavydovHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源19：rdavydov SOCKS5
  async fetchFromRdavydovSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源20：sunny9577
  async fetchFromSunny9577() {
    try {
      const url = 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源21：clarketm
  async fetchFromClarketm() {
    try {
      const url = 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源22：aslisk HTTP
  async fetchFromAsliskHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/aslisk/proxy-list/master/proxies/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => p.trim()).slice(0, 500);
    } catch { return []; }
  }

  // 源23：aslisk SOCKS5
  async fetchFromAsliskSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/aslisk/proxy-list/master/proxies/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data.split('\n').filter((p) => p && p.includes(':')).map((p) => `socks5://${p.trim()}`).slice(0, 300);
    } catch { return []; }
  }

  // 源24：ProxyScrape HTTPS
  async fetchFromProxyScrapeHttps() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=https&timeout=8000&country=all';
      const response = await axios.get(url, { timeout: 10000 });
      return response.data.split('\r\n').filter((p) => p && p.includes(':')).map((p) => p.trim());
    } catch { return []; }
  }

  // 源25：ProxyScrape SOCKS4
  async fetchFromProxyScrapeSocks4() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks4&timeout=8000&country=all';
      const response = await axios.get(url, { timeout: 10000 });
      return response.data.split('\r\n').filter((p) => p && p.includes(':')).map((p) => `socks4://${p.trim()}`);
    } catch { return []; }
  }

  // ============ 代理源获取（25源并发）============
  async fetchProxiesFast() {
    console.log('[AmazonProxy] 获取代理列表（25个源并发）...');
    const allProxies = new Set();

    // 25个代理源
    const sources = [
      this.fetchFromProxyScrape(),
      this.fetchFromGeonode(),
      this.fetchFromGeonodePage2(),
      this.fetchFromTheSpeedX(),
      this.fetchFromFreeProxyList(),
      this.fetchFromSocksProxyScrape(),
      this.fetchFromTheSpeedXSocks(),
      this.fetchFromJetkaiHttp(),
      this.fetchFromJetkaiSocks5(),
      this.fetchFromHookzofSocks5(),
      this.fetchFromHubpAll(),
      this.fetchFromMonosansHttp(),
      this.fetchFromMonosansSocks5(),
      this.fetchFromRoosterkidHttps(),
      this.fetchFromRoosterkidSocks5(),
      this.fetchFromShiftyTRHttp(),
      this.fetchFromShiftyTRSocks5(),
      this.fetchFromRdavydovHttp(),
      this.fetchFromRdavydovSocks5(),
      this.fetchFromSunny9577(),
      this.fetchFromClarketm(),
      this.fetchFromAsliskHttp(),
      this.fetchFromAsliskSocks5(),
      this.fetchFromProxyScrapeHttps(),
      this.fetchFromProxyScrapeSocks4(),
    ];

    const results = await Promise.allSettled(sources);

    let successSources = 0;
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
        successSources++;
        result.value.forEach((p) => allProxies.add(p));
      }
    });

    // 按协议统计
    const httpCount = Array.from(allProxies).filter(p => !p.startsWith('socks')).length;
    const socksCount = Array.from(allProxies).filter(p => p.startsWith('socks')).length;

    console.log(`[AmazonProxy] 获取到 ${allProxies.size} 个代理 (成功源:${successSources}/25, HTTP:${httpCount}, SOCKS:${socksCount})`);
    return Array.from(allProxies);
  }

  // ============ 预验证代理（快速测试是否可达）============
  async verifyProxies(proxyList) {
    if (!proxyList || proxyList.length === 0) return [];
    
    const now = Date.now();
    if (now - this.lastVerificationTime < this.verificationInterval && this.verifiedPool.length > 0) {
      return this.verifiedPool;
    }

    // 限制验证数量，最多500个（避免验证时间过长）
    const toVerify = proxyList.slice(0, 500);
    console.log(`[AmazonProxy] 开始预验证 ${toVerify.length}/${proxyList.length} 个代理（快速连通性测试）...`);
    this.verifying = true;
    const verified = [];
    const batchSize = 30; // 每批验证30个（SOCKS较慢，减小并发）
    const testTimeout = 8000; // 8秒超时（SOCKS较慢，给多点时间）

    // 分批验证
    for (let i = 0; i < toVerify.length; i += batchSize) {
      const batch = toVerify.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (proxy) => {
          try {
            const agent = this.createAgent(proxy);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), testTimeout);
            
            const resp = await axios.get('http://checkip.amazonaws.com/', {
              httpAgent: agent,
              httpsAgent: agent,
              timeout: testTimeout,
              signal: controller.signal,
              validateStatus: () => true,
            });
            clearTimeout(timer);
            
            if (resp.status === 200) {
              return { proxy, ok: true };
            }
            return { proxy, ok: false };
          } catch {
            return { proxy, ok: false };
          }
        })
      );

      results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value.ok) {
          verified.push(r.value.proxy);
        }
      });
    }

    this.verifiedPool = verified;
    this.lastVerificationTime = now;
    this.verifying = false;

    console.log(`[AmazonProxy] 预验证完成: ${verified.length}/${proxyList.length} 个代理可达`);
    return verified;
  }

  // ============ 代理刷新 ============
  async refreshProxies(force = false) {
    const now = Date.now() / 1000;

    // 防抖：非强制刷新时检查最小间隔
    if (!force && now - this.lastRefreshTime < this.refreshInterval && this.proxies.length > 0) {
      return this.proxies;
    }

    // 防止并发刷新
    if (this.refreshing) {
      console.log('[AmazonProxy] 刷新进行中，跳过本次请求');
      return this.proxies;
    }

    this.refreshing = true;
    try {
      const existingGood = this.proxies.filter((p) => !this.badProxies.has(p));
      const newProxies = await this.fetchProxiesFast();

      // 合并：已知好的 + 新获取的
      const merged = new Set([...this.knownGoodProxies, ...existingGood, ...newProxies]);
      const mergedList = Array.from(merged).filter((p) => !this.badProxies.has(p));

      // *** 关键修复：先立即填充代理池，让请求能拿到代理 ***
      // 如果当前池子太小，先用未验证的代理填充，避免请求期间无代理可用
      if (this.proxies.length < 50 && mergedList.length > 0) {
        this.proxies = mergedList;
        this.usedCount.clear();
        console.log(`[AmazonProxy] 快速填充: ${mergedList.length} 个未验证代理 (后台验证中...)`);
      }

      // 预验证：对合并后的代理池做快速连通性测试
      // 对所有非已知好代理做验证（包括HTTP和SOCKS）
      const needVerify = mergedList.filter(
        p => !this.knownGoodProxies.includes(p) && !this.badProxies.has(p)
      );
      const verified = needVerify.length > 0 ? await this.verifyProxies(needVerify) : [];

      // 最终池：已知好代理 + 已验证通过
      // 只有验证通过的才会进入代理池，避免浪费时间试不可达的代理
      const finalList = [
        ...this.knownGoodProxies.filter(p => !this.badProxies.has(p)),
        ...verified,
      ];

      this.proxies = finalList;
      this.usedCount.clear();
      this.lastRefreshTime = now;

      console.log(`[AmazonProxy] 刷新完成: ${finalList.length} 个代理 (已知好:${this.knownGoodProxies.length}, 已验证:${verified.length})`);
      return finalList;
    } catch (e) {
      console.error('[AmazonProxy] 刷新失败:', e.message);
      this.proxies = [...this.knownGoodProxies];
      return this.proxies;
    } finally {
      this.refreshing = false;
    }
  }

  // ============ 自动刷新定时器（每5分钟，比之前更频繁）============
  startAutoRefresh(intervalMinutes = 5) {
    // 先停止已有的定时器
    this.stopAutoRefresh();

    this.autoRefreshIntervalMs = intervalMinutes * 60 * 1000;

    console.log(`[AmazonProxy] 启动自动刷新定时器：每${intervalMinutes}分钟刷新一次`);

    this.autoRefreshTimer = setInterval(async () => {
      if (!this.enabled) {
        console.log('[AmazonProxy] 代理已禁用，跳过自动刷新');
        return;
      }
      try {
        console.log(`[AmazonProxy] 自动刷新触发 ${new Date().toISOString()}`);
        const before = this.proxies.length;
        const after = await this.refreshProxies(true);
        console.log(`[AmazonProxy] 自动刷新完成: ${before} → ${after.length} 个代理`);
      } catch (e) {
        console.error('[AmazonProxy] 自动刷新异常:', e.message);
      }
    }, this.autoRefreshIntervalMs);

    // 确保定时器不会阻止进程退出
    if (this.autoRefreshTimer.unref) {
      this.autoRefreshTimer.unref();
    }
  }

  // 停止自动刷新定时器
  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
      console.log('[AmazonProxy] 已停止自动刷新定时器');
    }
  }

  // 获取自动刷新状态
  getAutoRefreshStatus() {
    return {
      enabled: this.autoRefreshTimer !== null,
      interval_minutes: this.autoRefreshIntervalMs / (60 * 1000),
      last_refresh_time: this.lastRefreshTime ? new Date(this.lastRefreshTime * 1000).toISOString() : null,
      next_refresh_in_seconds: this.autoRefreshTimer
        ? Math.max(0, this.autoRefreshIntervalMs / 1000 - (Date.now() / 1000 - this.lastRefreshTime))
        : null,
    };
  }

  // ============ 批量获取代理（用于并发请求）============
  getProxyBatch(count) {
    const batch = [];
    for (let i = 0; i < count; i++) {
      const p = this.getProxy();
      if (p) batch.push(p);
    }
    return batch;
  }

  // ============ 获取代理（轮询策略）============
  getProxy() {
    if (!this.enabled) {
      return null;
    }

    // 清理过期的坏代理标记
    const now = Date.now();
    this.badProxies.forEach((timestamp, proxy) => {
      if (proxy.startsWith('__')) return; // 跳过计数器
      if (now - timestamp > this.badProxyTTL * 1000) {
        this.badProxies.delete(proxy);
        this.badProxies.delete('__fail_count_' + proxy);
      }
    });

    // 优先使用已知好代理（必须是近期无失败的）
    const preferred = this.knownGoodProxies.filter(
      (p) =>
        !this.badProxies.has(p) &&
        (this.badProxies.get('__fail_count_' + p) || 0) === 0 &&
        (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (preferred.length > 0) {
      const proxy = preferred[Math.floor(Math.random() * preferred.length)];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 从已验证池中选取
    const verifiedAvailable = this.verifiedPool.filter(
      (p) =>
        !this.badProxies.has(p) &&
        !this.knownGoodProxies.includes(p) &&
        (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (verifiedAvailable.length > 0) {
      this.proxyIndex = (this.proxyIndex + 1) % verifiedAvailable.length;
      const proxy = verifiedAvailable[this.proxyIndex];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 从大代理池中轮询选择
    const available = this.proxies.filter(
      (p) =>
        !this.badProxies.has(p) &&
        !this.knownGoodProxies.includes(p) &&
        (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (available.length > 0) {
      this.proxyIndex = (this.proxyIndex + 1) % available.length;
      const proxy = available[this.proxyIndex];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 兜底：重置所有使用计数
    if (this.proxies.length > 0) {
      const nonBad = this.proxies.filter((p) => !this.badProxies.has(p));
      if (nonBad.length > 0) {
        this.usedCount.clear();
        this.proxyIndex = (this.proxyIndex + 1) % nonBad.length;
        const proxy = nonBad[this.proxyIndex];
        this.usedCount.set(proxy, 1);
        return proxy;
      }
    }

    // 最后兜底：已知好代理（强制重置失败计数）
    if (this.knownGoodProxies.length > 0) {
      const proxy = this.knownGoodProxies[Math.floor(Math.random() * this.knownGoodProxies.length)];
      this.badProxies.delete(proxy);
      this.badProxies.delete('__fail_count_' + proxy);
      return proxy;
    }

    return null;
  }

  // ============ 标记失败/成功 ============
  markFailed(proxy) {
    if (!proxy) return;
    const isKnownGood = this.knownGoodProxies.includes(proxy);
    const failCount = (this.badProxies.get('__fail_count_' + proxy) || 0) + 1;

    if (isKnownGood) {
      // 已知好代理：失败2次后暂时标记，30秒后恢复
      if (failCount >= 2) {
        this.badProxies.set(proxy, Date.now());
        this.badProxies.set('__fail_count_' + proxy, 0);
        console.log(`[AmazonProxy] 已知代理 ${proxy} 失败2次，暂时跳过`);
      } else {
        this.badProxies.set('__fail_count_' + proxy, failCount);
      }
    } else {
      // 其他代理：失败1次即标记为坏
      this.badProxies.set(proxy, Date.now());
      this.proxies = this.proxies.filter((p) => p !== proxy);
      this.verifiedPool = this.verifiedPool.filter((p) => p !== proxy);
      this.usedCount.delete(proxy);
    }
  }

  markSuccess(proxy) {
    if (!proxy) return;
    this.badProxies.delete('__fail_count_' + proxy);
    this.badProxies.delete(proxy);
    // 成功的代理加入已知好代理列表
    if (!this.knownGoodProxies.includes(proxy) && this.knownGoodProxies.length < this.maxKnownGood) {
      this.knownGoodProxies.push(proxy);
      // 也加入已验证池
      if (!this.verifiedPool.includes(proxy)) {
        this.verifiedPool.push(proxy);
      }
      console.log(`[AmazonProxy] 代理 ${proxy} 成功，加入已知好代理列表 (共${this.knownGoodProxies.length}个)`);
    }
  }

  getRandomUA() {
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }
}

module.exports = new ProxyManager();