const proxyManager = require('./proxy');
const cheerio = require('cheerio');
const { getSiteConfig } = require('./sites');
const guard = require('./guard');
const { curlRequest, CookieJar } = require('./curlClient');
const { isBlocked, parseStyleSnap, isUnsupportedCategory } = require('./parser');

const DATA_VERSION = '2.0';
const CHANNEL = 'amazon-stylesnap-web';

// 硬约束：单请求8s超时；总预算60s；每轮3代理竞速；最多8轮；每代理最多5次
const STEP_TIMEOUT = 8000;
const TOTAL_BUDGET = 60000;
const CONCURRENCY = 3;
const ROUNDS = 8;

const MIN_REQUEST_INTERVAL = 300; // 全局请求间隔300ms + 随机抖动
let lastRequestTime = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rateLimit() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - elapsed + Math.random() * 200);
  }
  lastRequestTime = Date.now();
}

const LANG_MAP = {
  en: 'en-US,en;q=0.9', ja: 'ja-JP,ja;q=0.9', de: 'de-DE,de;q=0.9', fr: 'fr-FR,fr;q=0.9',
  it: 'it-IT,it;q=0.9', es: 'es-ES,es;q=0.9', pt: 'pt-BR,pt;q=0.9', ko: 'ko-KR,ko;q=0.9',
  nl: 'nl-NL,nl;q=0.9', sv: 'sv-SE,sv;q=0.9', pl: 'pl-PL,pl;q=0.9', zh: 'zh-CN,zh;q=0.9',
};

/**
 * 单个代理上的 StyleSnap 会话：入口页取匿名token -> 注册weblab -> 上传
 * 三步必须同一代理IP、同一套匿名会话 cookie；用户图片字节经预组装multipart走 stdin，不落盘
 * 注：/shopthelook 实测无需首页预热即可直接返回200+token并Set-Cookie，省去一次8s超时风险
 */
async function stylesnapSession(proxy, { domain, origin, entryUrl, uploadBase, buf, mime, lang, signal }) {
  const ua = proxyManager.getRandomUA(false);
  const acceptLang = LANG_MAP[lang] || `${lang},${lang};q=0.9`;
  const jar = new CookieJar();
  const common = {
    'User-Agent': ua,
    'Accept-Language': acceptLang,
  };

  // 1) 入口页取匿名 stylesnap token（页面公开 hidden input，非登录态；302 自行跟随）
  await rateLimit();
  let r = await curlRequest({
    proxy, url: entryUrl,
    headers: {
      ...common,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
    cookies: jar.toString(), timeoutMs: STEP_TIMEOUT, followRedirects: true,
  });
  if (signal && signal.aborted) return { ok: false, error: '已中止' };
  if (!r.ok) return { ok: false, error: `入口页失败:${r.error}` };
  jar.ingest(r.headerDump);

  const html = r.body.toString('utf8');
  if (isBlocked(html)) return { ok: false, error: '入口页被风控拦截', blocked: true };
  let token = '';
  try {
    const $ = cheerio.load(html);
    token = ($("input[name='stylesnap']").attr('value')
      || $('input#stylesnap').attr('value') || '').trim();
  } catch { /* 用正则兜底 */ }
  if (!token) token = (html.match(/name=["']stylesnap["']\s+value=["']([^"']+)/) || [])[1] || '';
  if (!token || html.length < 50000) {
    return { ok: false, error: '入口页无效（无stylesnap token）' };
  }

  // 2.5) 注册 weblab 实验（真实客户端必发的XHR；会补种 ubid-main 等会话cookie，缺失时识别后端可能返回空盒）
  const wb = await curlRequest({
    proxy,
    url: `${origin}/stylesnap/api/registered-weblabs?packageName=A9VSStyleSnapWebReactAssets`,
    headers: {
      ...common,
      'Accept': '*/*',
      'Referer': entryUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    cookies: jar.toString(), timeoutMs: STEP_TIMEOUT, followRedirects: true,
  });
  if (wb.ok) jar.ingest(wb.headerDump); // 失败不致命，继续上传

  // 3) XHR 风格上传（multipart 文件字段名=explore-looks.jpg/png，经 stdin 传图）
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const fieldName = `explore-looks.${ext}`;
  await rateLimit();
  r = await curlRequest({
    proxy,
    url: `${uploadBase}?stylesnapToken=${encodeURIComponent(token)}`,
    method: 'POST',
    headers: {
      ...common,
      'Accept': '*/*',
      'Origin': origin,
      'Referer': entryUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    cookies: jar.toString(),
    timeoutMs: STEP_TIMEOUT,
    followRedirects: false,
    fileField: { name: fieldName, filename: fieldName, contentType: mime, buffer: buf },
  });
  if (signal && signal.aborted) return { ok: false, error: '已中止' };
  if (!r.ok) return { ok: false, error: `上传失败:${r.error}` };

  const text = r.body.toString('utf8').trim();
  if (r.status !== 200) {
    if (isBlocked(text)) return { ok: false, error: '上传被风控拦截', blocked: true };
    if (r.status === 403) return { ok: false, error: '403令牌/会话被拒' };
    if (r.status === 400) return { ok: false, error: '400请求被拒（图片/字段不符）' };
    if (r.status === 405) return { ok: false, error: '405方法不允许（端点变更）' };
    return { ok: false, error: `HTTP ${r.status}` };
  }
  if (text === '[object Object]') {
    // Amazon 风控对可疑 TLS 指纹/低信誉IP 的静默降级响应
    return { ok: false, error: '风控静默降级([object Object])，需更换代理出口' };
  }
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: '响应非JSON（可能为拦截页）' }; }
  if (!Array.isArray(data.searchResults)) return { ok: false, error: 'JSON缺少searchResults' };
  if (!data.searchResults.length) return { ok: false, empty: true, data, error: '识别结果为空（换出口重试）' };

  return { ok: true, data, token, proxy };
}

/**
 * 多代理竞速：每轮3个完整会话并发，首个拿到合法JSON即胜，其余发中止信号
 */
async function raceStyleSnap({ domain, origin, entryUrl, uploadBase, buf, mime, lang }) {
  const start = Date.now();
  const trace = [];

  for (let round = 0; round < ROUNDS; round++) {
    if (Date.now() - start >= TOTAL_BUDGET) break;

    const proxies = [];
    const seen = new Set();
    while (proxies.length < CONCURRENCY) {
      const p = proxyManager.getProxy();
      if (!p) break;
      if (seen.has(p)) continue;
      seen.add(p);
      proxies.push(p);
      proxyManager.noteUses(p, 2); // 本会话共3次请求（入口/weblabs/上传；getProxy已计1次）
    }
    if (!proxies.length) { await sleep(300); continue; }

    const signal = { aborted: false };
    const tasks = proxies.map(async p => {
      const t0 = Date.now();
      try {
        const r = await stylesnapSession(p, { domain, origin, entryUrl, uploadBase, buf, mime, lang, signal });
        return { p, r, ms: Date.now() - t0 };
      } catch (e) {
        return { p, r: { ok: false, error: e.message }, ms: Date.now() - t0 };
      }
    });

    let winner = null;
    const settled = await Promise.all(tasks.map(tp => tp.then(t => {
      trace.push({ proxy: t.p, round: round + 1, ok: t.r.ok, empty: !!t.r.empty, status: t.r.blocked ? 'blocked' : (t.r.ok ? 'success' : t.r.error), ms: t.ms });
      if (t.r.ok) {
        proxyManager.markSuccess(t.p);
        if (!winner) winner = t;
      } else if (t.r.empty) {
        // 代理本身可用，仅识别为空：不惩罚，继续换出口
        proxyManager.markSuccess(t.p);
      } else {
        proxyManager.markFailed(t.p);
      }
      return t;
    })));

    if (winner) {
      signal.aborted = true;
      return { ok: true, data: winner.r.data, proxy: winner.p, elapsed_ms: Date.now() - start, trace };
    }
  }

  const summary = [...new Set(trace.map(t => t.status))].slice(0, 6).join(' | ');
  return { ok: false, error: `全部${trace.length}个代理会话失败：${summary || '代理池为空'}`, trace, elapsed_ms: Date.now() - start };
}

// URL 输入：经代理下载图片（SSRF 安全 + 魔数校验），3代理竞速
async function downloadViaProxy(imageUrl) {
  const start = Date.now();
  for (let round = 0; round < 4; round++) {
    if (Date.now() - start >= 30000) break;
    const proxies = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const p = proxyManager.getProxy();
      if (p && !proxies.includes(p)) proxies.push(p);
    }
    if (!proxies.length) { await sleep(300); continue; }

    const referer = new URL(imageUrl).origin + '/';
    const results = await Promise.all(proxies.map(async proxy => {
      const r = await curlRequest({
        proxy, url: imageUrl, timeoutMs: STEP_TIMEOUT, followRedirects: true,
        headers: {
          'User-Agent': proxyManager.getRandomUA(),
          'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
          'Referer': referer,
        },
      });
      if (!r.ok || r.status !== 200) { proxyManager.markFailed(proxy); return { ok: false }; };
      proxyManager.markSuccess(proxy);
      return { ok: true, buffer: r.body };
    }));
    const win = results.find(x => x.ok);
    if (win) {
      const buf = win.buffer;
      const mime = guard.sniffImage(buf);
      if (!mime) return { ok: false, error: 'URL内容魔数校验失败（不是有效图片）' };
      if (buf.length < guard.MIN_IMAGE_BYTES) return { ok: false, error: '图片过小（至少1KB）' };
      if (buf.length > guard.MAX_IMAGE_BYTES) return { ok: false, error: '图片超过5MB' };
      return { ok: true, buffer: buf, mime };
    }
  }
  return { ok: false, error: '经代理下载图片失败（所有代理均不可用）' };
}

async function searchByImage({ image, country = 'com', lang = 'en' }) {
  const site = getSiteConfig(country);
  if (!site) {
    return { success: false, data_version: DATA_VERSION, error: `不支持的站点: ${country}` };
  }

  // 1) 输入校验（类型白名单 + 魔数 + 大小 + SSRF）
  const input = guard.normalizeImageInput(image);
  if (input.error) {
    return { success: false, data_version: DATA_VERSION, http_status: 400, error: input.error };
  }

  let buf;
  let mime;
  if (input.type === 'url') {
    const safeUrl = input.url.replace(/([?&])(sig|key|token|signature)=[^&]+/gi, '$1$2=***');
    console.log(`[ImageSearch] 经代理下载图片: ${safeUrl}`);
    const dl = await downloadViaProxy(input.url);
    if (!dl.ok) {
      return { success: false, data_version: DATA_VERSION, error: dl.error };
    }
    buf = dl.buffer; mime = dl.mime;
  } else {
    buf = input.buffer; mime = input.mime;
  }

  // StyleSnap 上传仅接受 jpeg/png（其前端常量 {jpg:"image/jpeg",png:"image/png"}）
  if (mime === 'image/webp') {
    return {
      success: false, data_version: DATA_VERSION, http_status: 400,
      error: 'StyleSnap 通道仅支持 jpeg/png，请先将 webp 转为 jpg 或 png',
    };
  }

  const domain = site.domain;
  const origin = `https://${domain}`;
  const entryUrl = `${origin}/shopthelook?language=${lang === 'en' ? 'en_US' : lang}`;
  const uploadBase = `${origin}/stylesnap/upload`;

  // 2) robots 协议校验（实时拉取，失败时走已人工核实白名单）
  await guard.assertRobotsAllowed(domain, '/shopthelook');
  await guard.assertRobotsAllowed(domain, '/stylesnap/upload');

  console.log(`[ImageSearch] StyleSnap 会话竞速: ${domain} ${buf.length}B ${mime}`);

  // 3) 多代理会话竞速（预热+token+上传 同一IP完成）
  const race = await raceStyleSnap({ domain, origin, entryUrl, uploadBase, buf, mime, lang });
  if (!race.ok) {
    return {
      success: false,
      data_version: DATA_VERSION,
      country,
      channel: CHANNEL,
      error: race.error,
      strategy_trace: race.trace,
      elapsed_ms: race.elapsed_ms,
    };
  }

  // 4) 不支持品类（StyleSnap 明确返回 unsupported-category）
  if (isUnsupportedCategory(race.data)) {
    return {
      success: false,
      data_version: DATA_VERSION,
      http_status: 422,
      country,
      channel: CHANNEL,
      query_id: race.data.queryId || null,
      error: '亚马逊StyleSnap不支持该图片品类（仅支持服饰/鞋包/家居等可售商品）',
      proxy_used: race.proxy,
      elapsed_ms: race.elapsed_ms,
      strategy_trace: race.trace,
    };
  }

  // 5) 解析结构化结果
  const parsed = parseStyleSnap(race.data, site);
  if (!parsed.products.length) {
    return {
      success: false,
      data_version: DATA_VERSION,
      country,
      channel: CHANNEL,
      query_id: parsed.query_id,
      error: '识别成功但未匹配到可售商品（空结果）',
      detections: parsed.detections,
      proxy_used: race.proxy,
      elapsed_ms: race.elapsed_ms,
      strategy_trace: race.trace,
    };
  }

  return {
    success: true,
    data_version: DATA_VERSION,
    country,
    lang,
    channel: CHANNEL,
    query_id: parsed.query_id,
    total_results: parsed.total_results,
    detections: parsed.detections,
    products: parsed.products,
    result_url: (parsed.detections.find(d => d.result_url) || {}).result_url || null,
    proxy_used: race.proxy,
    elapsed_ms: race.elapsed_ms,
    strategy_trace: race.trace,
  };
}

module.exports = { searchByImage, DATA_VERSION };
