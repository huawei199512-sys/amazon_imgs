const express = require('express');
const cors = require('cors');
const scraper = require('./scraper');
const sites = require('./sites');
const proxyManager = require('./proxy');
const app = express();
const PORT = process.env.PORT || 8000;
app.use(cors());
app.use(express.json());
// ============ 全局错误防护（防止未捕获异常导致服务崩溃）============
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err && err.message ? err.message : err);
});
// ============ 健康检查端点（Render 必需，必须最先注册）============
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});
// ============ 首页 ============
app.get('/', (req, res) => {
  res.json({
    service: 'Amazon Product API',
    version: '2.0.0 (Pro)',
    description: 'Amazon商品详情和关键字搜索API - 纯代理模式',
    mode: 'proxy',
    features: {
      proxy_mode: '纯代理模式（所有请求通过代理IP）',
      supported_sites: sites.getAllSiteKeys(),
      search_params: {
        keyword: '搜索关键字（必填）',
        country: '站点代码，如: com, jp, de, co.uk, fr, it, es, ca',
        lang: '语言代码，如: en, ja, de, fr, zh',
        page: '页码，从1开始',
      },
      product_params: {
        asin: '商品ASIN（路径参数）',
        country: '站点代码',
        lang: '语言代码',
      },
    },
    proxy_status: proxyManager.getStatus(),
  });
});
// ============ 站点列表 ============
app.get('/api/sites', (req, res) => {
  const siteList = Object.entries(sites.SITES).map(([code, config]) => ({
    code,
    domain: config.domain,
    country: config.country,
    currency: config.currency,
    language: config.language,
  }));
  res.json(siteList);
});
// ============ 搜索商品 ============
app.get('/api/search', async (req, res) => {
  try {
    const { keyword, country = 'com', lang = 'en', page = 1 } = req.query;
    if (!keyword) {
      return res.status(400).json({ success: false, error: 'keyword参数必填' });
    }
    if (!sites.getSiteConfig(country)) {
      return res.status(400).json({
        success: false,
        error: `不支持的站点: ${country}`,
        supported_sites: sites.getAllSiteKeys()
      });
    }
    // 强制启用代理
    proxyManager.setEnabled(true);
    const result = await scraper.searchProducts(keyword, country, lang, parseInt(page));
    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ============ 商品详情 ============
app.get('/api/product/:asin', async (req, res) => {
  try {
    const { asin } = req.params;
    const { country = 'com', lang = 'en' } = req.query;
    if (!sites.getSiteConfig(country)) {
      return res.status(400).json({
        success: false,
        error: `不支持的站点: ${country}`,
        supported_sites: sites.getAllSiteKeys()
      });
    }
    // 强制启用代理
    proxyManager.setEnabled(true);
    const result = await scraper.getProductDetail(asin, country, lang);
    res.json({ ...result, data_version: '1.1' });
  } catch (error) {
    console.error('Product detail error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ============ 代理状态 ============
app.get('/api/proxy/status', (req, res) => {
  res.json(proxyManager.getStatus());
});
// ============ 手动刷新代理池 ============
app.post('/api/proxy/refresh', async (req, res) => {
  try {
    await proxyManager.refreshProxies(true);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post('/api/proxy/toggle', (req, res) => {
  proxyManager.setEnabled(true);
  res.json({ success: true, proxy_enabled: true, note: '代理模式为强制开启状态' });
});
// ============ 兜底路由（返回JSON而非默认404页面）============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `路径不存在: ${req.method} ${req.path}`,
    available_endpoints: [
      'GET /',
      'GET /health',
      'GET /api/sites',
      'GET /api/search?keyword=xxx&country=com&lang=en&page=1',
      'GET /api/product/:asin?country=com&lang=en',
      'GET /api/proxy/status',
      'POST /api/proxy/refresh',
    ],
  });
});
// ============ 关键：先启动服务器，再做后台初始化 ============
// Render 健康检查需要服务立即响应，不能等代理池初始化
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  Amazon Product API Pro 已启动');
  console.log('  监听端口: ' + PORT);
  console.log('  模式: 强制代理模式');
  console.log('  站点数: ' + sites.getAllSiteKeys().length);
  console.log('========================================');
  // 服务启动后，后台静默初始化代理池（不阻塞请求）
  setTimeout(async () => {
    try {
      console.log('[Init] 后台初始化代理池...');
      await proxyManager.refreshProxies(true);
      // 启动自动刷新定时器（每5分钟，免费代理变化快）
      proxyManager.startAutoRefresh(5);
      console.log('[Init] 代理池初始化完成');
    } catch (e) {
      console.warn('[Init] 代理池初始化失败（不影响服务运行，请求时重试）:', e.message);
      // 即使初始化失败，仍然启动定时器（5分钟后重试）
      proxyManager.startAutoRefresh(5);
    }
  }, 1000);
});