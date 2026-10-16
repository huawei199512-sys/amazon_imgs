const express = require('express');
const cors = require('cors');
const proxyManager = require('./proxy');
const sites = require('./sites');
const { searchByImage, DATA_VERSION } = require('./imageSearch');
const guard = require('./guard');

const app = express();
const PORT = process.env.PORT || 8001;

app.set('trust proxy', 1);
app.use(cors());
// 5MB图片 base64 约 6.7MB，给10MB上限
app.use(express.json({ limit: '10mb' }));

// 基础安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 全局异常防护（单请求异常不导致进程崩溃）
process.on('uncaughtException', err => console.error('[UncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[UnhandledRejection]', err && err.message ? err.message : err));

// 客户端限流（每IP每分钟12次图搜）
const limiter = new guard.RateLimiter(12, 60000);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Amazon Image Search API',
    data_version: DATA_VERSION,
    description: 'Amazon图搜API（Shop the Look / StyleSnap 匿名通道）- 安全采集规范',
    channel: 'GET /shopthelook 取匿名token -> POST /stylesnap/upload -> JSON(bbxAsinList)',
    endpoints: {
      image_search: 'GET/POST /api/image-search  GET: ?image=URL&country=com&lang=en  POST body: { image, country, lang }',
      sites: 'GET /api/sites',
      proxy_status: 'GET /api/proxy/status',
      proxy_refresh: 'GET/POST /api/proxy/refresh',
      proxy_seeds: 'POST /api/proxy/seeds  body: { proxies: [...] }',
    },
    supported_sites: sites.getAllSiteKeys(),
    limits: {
      image_max: '5MB',
      image_types: ['jpeg', 'png'],
      rate: '12次/分钟/IP',
      proxy_mode: 'forced',
    },
    proxy_status: proxyManager.getStatus(),
  });
});

app.get('/api/sites', (req, res) => {
  res.json(Object.entries(sites.SITES).map(([code, c]) => ({ code, ...c })));
});

// ============ 核心：图搜（GET & POST 共用）============
async function handleImageSearch(req, res) {
  const clientKey = req.ip || (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || 'unknown';
  if (!limiter.check(clientKey)) {
    return res.status(429).json({
      success: false,
      data_version: DATA_VERSION,
      error: '请求过于频繁，限流：每分钟最多12次',
    });
  }
  // GET 从 query 读，POST 从 body 读
  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const { image, country = 'com', lang = 'en' } = src;
  try {
    if (!image) {
      return res.status(400).json({ success: false, data_version: DATA_VERSION, error: 'image 参数必填（GET 用 ?image=https://... 或 POST body.image）' });
    }
    if (!sites.getSiteConfig(country)) {
      return res.status(400).json({
        success: false,
        data_version: DATA_VERSION,
        error: `不支持的站点: ${country}`,
        supported_sites: sites.getAllSiteKeys(),
      });
    }

    proxyManager.setEnabled(true); // 强制代理，不允许关闭
    const result = await searchByImage({ image, country, lang });
    const httpStatus = result.http_status || (result.success ? 200 : 502);
    res.status(httpStatus).json(result);
  } catch (error) {
    console.error('[ImageSearch] error:', error.code || error.message);
    const status = error.code === 'ROBOTS_DENIED' || error.code === 'ROBOTS_UNKNOWN' ? 403 : 500;
    res.status(status).json({ success: false, data_version: DATA_VERSION, error: error.message });
  }
}
app.get('/api/image-search', handleImageSearch);
app.post('/api/image-search', handleImageSearch);

app.get('/api/proxy/status', (req, res) => {
  res.json(proxyManager.getStatus());
});

async function refreshProxiesEndpoint(req, res) {
  try {
    await proxyManager.refreshProxies(true);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
app.get('/api/proxy/refresh', refreshProxiesEndpoint);
app.post('/api/proxy/refresh', refreshProxiesEndpoint);

// 运维：热注入已验证代理种子（纯内网运维接口，仅接受 host:port / scheme://host:port）
app.post('/api/proxy/seeds', (req, res) => {
  const list = (req.body && req.body.proxies) || [];
  if (!Array.isArray(list) || !list.every(p => typeof p === 'string' && /^(?:socks[45]h?:\/\/)?[\d.]+:\d{2,5}$/.test(p))) {
    return res.status(400).json({ success: false, error: 'proxies 必须为 host:port 字符串数组' });
  }
  res.json({ success: true, ...proxyManager.addSeeds(list) });
});

// 兜底路由（返回JSON而非默认404页面）
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `路径不存在: ${req.method} ${req.path}`,
    available_endpoints: [
      'GET /health',
      'GET /',
      'GET /api/sites',
      'GET/POST /api/image-search',
      'GET /api/proxy/status',
      'GET/POST /api/proxy/refresh',
      'POST /api/proxy/seeds',
    ],
  });
});

// 先监听，再后台初始化代理池（Render健康检查需要服务立即响应）
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  Amazon Image Search API 已启动');
  console.log('  端口:', PORT, ' 数据版本:', DATA_VERSION);
  console.log('  模式: 强制代理 / robots校验 / 图片魔数校验');
  console.log('========================================');

  setTimeout(async () => {
    try {
      await proxyManager.refreshProxies(true);
      console.log('[Init] 代理池初始化完成');
    } catch (e) {
      console.warn('[Init] 代理池初始化失败（不影响服务，请求时重试）:', e.message);
    }
  }, 1000);
});

// 5分钟定时刷新代理池，降低免费实例CPU/内存压力
setInterval(async () => {
  try {
    await proxyManager.refreshProxies(false);
  } catch (e) {
    console.warn('[AutoRefresh] 代理刷新失败:', e.message);
  }
}, 300000);
