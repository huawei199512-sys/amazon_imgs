const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('./proxy');
const { getSiteConfig } = require('./sites');

// 超时与并发策略（激进模式，针对免费代理优化）：
// - 单代理5秒超时：快速淘汰死代理
// - 每轮并发10个代理（Promise.race竞态）：第一个成功的立即返回
// - 30秒总超时：快速失败，不要等太久
// - 6轮 × 10并发 = 最多60个代理在30s内
const SINGLE_PROXY_TIMEOUT = 5000; // 单个代理5秒超时（之前8秒）
const TOTAL_REQUEST_TIMEOUT = 30000; // 总请求30秒超时（之前60秒）
const CONCURRENT_PROXIES = 10; // 每轮并发的代理数量（之前3个）
const MIN_REQUEST_INTERVAL = 100; // 100ms间隔（降低延迟，之前300ms）

// 详情接口专用：更长超时和更激进并发
const DETAIL_SINGLE_PROXY_TIMEOUT = 8000; // 详情单代理8秒超时（之前15秒）
const DETAIL_TOTAL_REQUEST_TIMEOUT = 60000; // 详情总请求60秒超时（之前90秒）
const DETAIL_CONCURRENT_PROXIES = 15; // 详情每轮并发15个代理（之前5个）
const DETAIL_MAX_ROUNDS = 8; // 详情最多8轮

let lastRequestTime = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - elapsed + Math.random() * 200);
  }
  lastRequestTime = Date.now();
}

function getHeaders(lang, domain) {
  const langMap = {
    en: 'en-US', ja: 'ja-JP', de: 'de-DE', fr: 'fr-FR',
    it: 'it-IT', es: 'es-ES', pt: 'pt-BR', ko: 'ko-KR',
    nl: 'nl-NL', sv: 'sv-SE', pl: 'pl-PL', zh: 'zh-CN',
  };
  return {
    'User-Agent': proxyManager.getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': `${langMap[lang] || lang},${lang};q=0.9`,
  };
}

function isBlocked(html) {
  const patterns = [
    'Robot Check', 'Enter the characters you see',
    'Sorry, we just need to make sure you\'re not a robot',
    'Sorry, you have been blocked', 'captcha', 'automated access',
    'request could not be processed',
  ];
  const lower = html.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

async function makeRequestWithProxy(url, params, lang = 'en', options = {}) {
  await rateLimit();

  const {
    singleProxyTimeout = SINGLE_PROXY_TIMEOUT,
    totalRequestTimeout = TOTAL_REQUEST_TIMEOUT,
    concurrentProxies = CONCURRENT_PROXIES,
    maxRounds = 8,
    extraHeaders = {},
  } = options;

  let fullUrl = url;
  if (params && typeof params === 'object') {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    fullUrl = url + (url.includes('?') ? '&' : '?') + queryString;
  }

  const domain = new URL(url).hostname;
  const headers = { ...getHeaders(lang, domain), ...extraHeaders };
  const startTime = Date.now();
  const attemptedProxies = [];

  if (!proxyManager.isEnabled()) {
    return { html: null, error: '代理模式未启用', attempted_proxies: attemptedProxies };
  }

  function getProxyBatch(count) {
    return proxyManager.getProxyBatch(count);
  }

  // 为单个代理创建请求任务（返回promise和abort函数）
  function createProxyTask(proxy) {
    const agent = proxyManager.createAgent(proxy);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), singleProxyTimeout);

    const taskPromise = axios.get(fullUrl, {
      headers, httpsAgent: agent, httpAgent: agent,
      timeout: singleProxyTimeout, signal: controller.signal,
      maxRedirects: 5, validateStatus: () => true,
    }).then(response => {
      clearTimeout(abortTimer);
      if (response.status === 200) {
        const html = response.data;
        if (isBlocked(html)) return { ok: false, blocked: true, error: '被反爬机制拦截' };
        return { ok: true, html, error: null };
      } else if (response.status === 302) {
        const loc = response.headers.location || '';
        if (loc.includes('signin') || loc.includes('login')) return { ok: false, error: '被重定向到登录页面' };
        return { ok: true, html: response.data, error: null };
      }
      return { ok: false, error: `代理返回${response.status}` };
    }).catch(error => {
      clearTimeout(abortTimer);
      const isTimeout = error.name === 'CanceledError' || error.name === 'AbortError' ||
                        error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                        error.code === 'ERR_CANCELED';
      return { ok: false, error: isTimeout ? '超时' : error.message };
    });

    return {
      proxy,
      promise: taskPromise,
      abort: () => {
        clearTimeout(abortTimer);
        try { controller.abort(); } catch {}
      }
    };
  }

  // 记录代理尝试结果
  function recordResult(proxy, result, roundStart) {
    const elapsed = ((Date.now() - roundStart) / 1000).toFixed(2);
    if (result.ok && result.html) {
      proxyManager.markSuccess(proxy);
      attemptedProxies.push({ proxy, status: 'success', time: elapsed });
    } else if (result.blocked) {
      proxyManager.markFailed(proxy);
      attemptedProxies.push({ proxy, status: 'blocked', time: elapsed });
    } else {
      proxyManager.markFailed(proxy);
      attemptedProxies.push({ proxy, status: result.error || 'error', time: elapsed });
    }
  }

  let round = 0;
  const seenProxies = new Set();

  while (round < maxRounds) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalRequestTimeout) {
      console.warn(`[Request] 总超时 (${(elapsed / 1000).toFixed(1)}s)`);
      break;
    }

    let batch = getProxyBatch(concurrentProxies * 2).filter(p => !seenProxies.has(p));
    batch = batch.slice(0, concurrentProxies);
    if (batch.length === 0) break;

    batch.forEach(p => seenProxies.add(p));
    console.log(`[Request] 第${round + 1}轮: 并发尝试 ${batch.length} 个代理 (竞态模式)...`);

    // 创建所有代理任务
    const tasks = batch.map(p => createProxyTask(p));
    const roundStartTime = Date.now();

    // 使用 Promise.race 实现真正的竞态
    // 第一个成功的代理立即返回，其余中止
    let successOutcome = null;
    let raceResolver;
    const racePromise = new Promise(resolve => { raceResolver = resolve; });

    const wrappedPromises = tasks.map(({ proxy, promise }) => {
      return promise.then(result => {
        if (!successOutcome && result.ok && result.html) {
          // 第一个成功的！记录并立即resolve race
          successOutcome = { proxy, result };
          recordResult(proxy, result, roundStartTime);
          raceResolver({ done: true });
        } else {
          recordResult(proxy, result, roundStartTime);
        }
        return { proxy, result };
      }).catch(err => {
        const result = { ok: false, error: err.message || '异常' };
        recordResult(proxy, result, roundStartTime);
        return { proxy, result };
      });
    });

    // 等待条件：racePromise(成功) 或 allDone(全部完成)
    const allDone = Promise.all(wrappedPromises);

    // 竞态：谁先完成用谁
    const raceResult = await Promise.race([
      racePromise,           // 第一个成功的立即完成
      allDone.then(() => ({ done: true, allFailed: !successOutcome })),  // 或全部失败
    ]);

    // 中止所有仍在运行的请求
    tasks.forEach(t => t.abort());

    if (successOutcome) {
      // 确保所有代理都被记录（被中止的标记为aborted）
      tasks.forEach(({ proxy }) => {
        if (!attemptedProxies.find(a => a.proxy === proxy)) {
          attemptedProxies.push({ proxy, status: 'aborted', time: ((Date.now() - roundStartTime) / 1000).toFixed(2) });
        }
      });

      return {
        html: successOutcome.result.html,
        error: null,
        proxy_used: successOutcome.proxy,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
        attempted_proxies: attemptedProxies,
      };
    }

    round++;
    await sleep(100);
  }

  const uniqueErrors = [...new Set(attemptedProxies.map(a => a.status))];
  const summary = uniqueErrors.length === 1 ? uniqueErrors[0] : uniqueErrors.join(', ');

  return {
    html: null,
    error: `所有${attemptedProxies.length}个代理失败 (${summary})`,
    proxy_used: 'none',
    attempted_proxies: attemptedProxies,
  };
}

function extractLdJson(html) {
  const results = [];
  const regex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      if (Array.isArray(data)) {
        results.push(...data);
      } else {
        results.push(data);
      }
    } catch {
      // ignore
    }
  }
  return results;
}

function extractAsinFromUrl(url) {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})/i,
    /asin=([A-Z0-9]{10})/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function searchProducts(keyword, country = 'com', lang = 'en', page = 1) {
  const siteConfig = getSiteConfig(country);
  if (!siteConfig) {
    return { success: false, error: `不支持的站点: ${country}` };
  }

  const searchUrl = siteConfig.searchUrl;
  const params = { k: keyword, page: page, ref: 'nb_sb_noss' };

  console.log(`[Search] 搜索 "${keyword}" on ${siteConfig.domain}, page ${page}`);

  const { html, error, proxy_used, elapsed, attempted_proxies } = await makeRequestWithProxy(searchUrl, params, lang);
  
  if (!html) {
    return { 
      success: false, 
      error: `搜索失败: ${error}`,
      proxy_used: proxy_used || 'none',
      attempted_proxies: attempted_proxies || [],
    };
  }

  const products = parseSearchResults(html, siteConfig);
  const totalResults = extractTotalResults(html);

  return {
    success: true,
    data_version: '1.4', // 版本标记方便验证
    keyword,
    country,
    page,
    total_results: totalResults || products.length,
    products,
    proxy_used: proxy_used,
    request_time: elapsed,
  };
}

function extractTotalResults(html) {
  try {
    const $ = cheerio.load(html);
    const text = $('span[data-component-type="s-result-info-bar"] .sg-col-inner').first().text();
    const match = text.replace(/,/g, '').match(/\d+/);
    if (match) return parseInt(match[0]);
  } catch {
    // ignore
  }
  return null;
}

function parseSearchResults(html, siteConfig) {
  const products = [];
  const $ = cheerio.load(html);
  const seenAsins = new Set();

  const items = $('div[data-asin]').filter((i, el) => {
    const asin = $(el).attr('data-asin');
    return asin && /^[A-Z0-9]{10}$/i.test(asin) && !seenAsins.has(asin);
  });

  items.each((i, element) => {
    try {
      const $item = $(element);
      const dataAsin = $item.attr('data-asin');
      if (!dataAsin || !/^[A-Z0-9]{10}$/i.test(dataAsin)) return;
      if (seenAsins.has(dataAsin)) return;
      seenAsins.add(dataAsin);

      const product = {
        asin: dataAsin,
        domain: siteConfig.domain,
        detail_url: `https://${siteConfig.domain}/dp/${dataAsin}`,
      };

      // 标题
      const titleSelectors = [
        'h2 a span', 'h2 span', '.a-text-normal', '[data-cy="title-recipe"] span',
      ];
      for (const sel of titleSelectors) {
        const titleElem = $item.find(sel).first();
        if (titleElem.length) {
          const titleText = titleElem.text().trim();
          if (titleText) {
            product.title = titleText;
            break;
          }
        }
      }

      // 链接和ASIN
      const linkElem = $item.find('h2 a').first();
      if (linkElem.length) {
        const href = linkElem.attr('href') || '';
        if (href) {
          const fullHref = href.startsWith('/') ? href : '/' + href;
          product.full_url = `https://${siteConfig.domain}${fullHref}`;
          const extractedAsin = extractAsinFromUrl(href);
          if (extractedAsin && extractedAsin !== dataAsin) {
            product.asin = extractedAsin;
            product.detail_url = `https://${siteConfig.domain}/dp/${extractedAsin}`;
          }
        }
      }

      // 图片
      const imageElem = $item.find('img.s-image, img[data-image-index]').first();
      if (imageElem.length) {
        product.image_url = imageElem.attr('src') || imageElem.attr('data-src') || '';
        product.image_alt = imageElem.attr('alt') || '';
      }

      // 价格
      const priceOffscreen = $item.find('.a-price .a-offscreen').first();
      if (priceOffscreen.length) {
        const priceText = priceOffscreen.text().trim();
        product.price = { display: priceText, currency: siteConfig.currency };
        const amountMatch = priceText.replace(/,/g, '').match(/[\d.]+/);
        if (amountMatch) product.price.amount = parseFloat(amountMatch[0]);
      } else {
        const priceWhole = $item.find('.a-price-whole').first();
        const priceFraction = $item.find('.a-price-fraction').first();
        const priceSymbol = $item.find('.a-price-symbol').first();
        if (priceWhole.length) {
          let priceText = priceWhole.text().trim().replace(/\.$/, '');
          if (priceFraction.length) priceText += '.' + priceFraction.text().trim();
          product.price = {
            display: `${priceSymbol.text().trim()}${priceText}`,
            currency: siteConfig.currency,
          };
        } else {
          product.price = null;
        }
      }

      // 评分
      const ratingElem = $item.find('span.a-icon-alt').first();
      if (ratingElem.length) {
        const ratingText = ratingElem.text().trim();
        product.rating = ratingText;
        product.rating_value = parseFloat(ratingText.split(' ')[0]) || null;
      }

      // 评论数
      const reviewCountSelectors = [
        'span[aria-label*="stars"] + span a span',
        '.a-size-small .a-link-normal .a-size-base',
        '[data-cy="review-rating-information"] .a-size-base',
      ];
      for (const sel of reviewCountSelectors) {
        const reviewElem = $item.find(sel).first();
        if (reviewElem.length) {
          const count = reviewElem.text().trim().replace(/,/g, '');
          if (count) {
            product.review_count = count;
            break;
          }
        }
      }

      // 是否Prime
      product.is_prime = $item.find('i.a-icon-prime, .a-icon-prime').length > 0;
      
      // 是否赞助
      const sponsoredElem = $item.find('span.a-color-secondary').first();
      product.is_sponsored = sponsoredElem.length > 0 && sponsoredElem.text().includes('Sponsored');

      if (product.title) {
        products.push(product);
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  return products;
}

async function getProductDetail(asin, country = 'com', lang = 'en') {
  const siteConfig = getSiteConfig(country);
  if (!siteConfig) {
    return { success: false, error: `不支持的站点: ${country}` };
  }

  const detailUrl = `https://${siteConfig.domain}/dp/${asin}?th=1&psc=1`;
  console.log(`[Detail] 获取商品详情: ${asin} from ${siteConfig.domain}`);

  // 详情接口使用更长超时和更激进并发
  const detailOptions = {
    singleProxyTimeout: DETAIL_SINGLE_PROXY_TIMEOUT,
    totalRequestTimeout: DETAIL_TOTAL_REQUEST_TIMEOUT,
    concurrentProxies: DETAIL_CONCURRENT_PROXIES,
    maxRounds: DETAIL_MAX_ROUNDS,
    extraHeaders: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  };

  const { html, error, proxy_used, elapsed, attempted_proxies } = await makeRequestWithProxy(detailUrl, null, lang, detailOptions);
  
  if (!html) {
    return { 
      success: false, 
      error: `获取商品详情失败: ${error}`,
      proxy_used: proxy_used || 'none',
      attempted_proxies: attempted_proxies || [],
    };
  }

  const product = parseProductDetail(html, asin, siteConfig, lang);
  const ldJson = extractLdJson(html);
  if (ldJson.length > 0) {
    product.ld_json = ldJson;
  }

  return {
    success: true,
    data_version: '1.4', // 版本标记方便验证
    asin,
    country,
    product,
    proxy_used: proxy_used,
    request_time: elapsed,
  };
}

function parseProductDetail(html, asin, siteConfig, lang) {
  const $ = cheerio.load(html);
  const product = {
    asin,
    domain: siteConfig.domain,
    country: siteConfig.country,
    currency: siteConfig.currency,
    language: lang,
    url: `https://${siteConfig.domain}/dp/${asin}`,
  };

  // 标题
  const titleElem = $('#productTitle, #title span').first();
  if (titleElem.length) {
    product.title = titleElem.text().trim();
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData) product.title = productData.name;
    }
  }

  // 品牌
  const brandElem = $('#bylineInfo, #brand, .po-brand').first();
  if (brandElem.length) {
    product.brand = brandElem.text().trim().replace(/^(Brand|Visit the|Brand:|Marque|Marke)\s*/i, '');
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.brand) {
        product.brand = productData.brand.name || productData.brand;
      }
    }
  }

  // 价格
  const priceElem = $('#priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox, #corePrice_feature_div .a-offscreen, #price, .a-price .a-offscreen').first();
  if (priceElem.length) {
    const priceText = priceElem.text().trim();
    product.price = { display: priceText, currency: siteConfig.currency };
    const amountMatch = priceText.replace(/,/g, '').match(/[\d.]+/);
    if (amountMatch) product.price.amount = parseFloat(amountMatch[0]);
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.offers) {
        const offers = productData.offers;
        if (offers.price) {
          product.price = {
            display: `${offers.priceCurrency || siteConfig.currency} ${offers.price}`,
            currency: offers.priceCurrency || siteConfig.currency,
            amount: parseFloat(offers.price),
          };
        }
      }
    }
  }

  // 原价
  const listPriceElem = $('#listPrice, #priceblock_listprice').first();
  if (listPriceElem.length) {
    product.list_price = listPriceElem.text().trim();
  }

  // 折扣
  const discountElem = $('#savingsPercent, #savings-percentage').first();
  if (discountElem.length) {
    product.discount = discountElem.text().trim();
  }

  // 库存状态
  const availabilityElem = $('#availability span, #outOfStock, #availability .a-color-success').first();
  if (availabilityElem.length) {
    product.availability = availabilityElem.text().trim();
    const availLower = product.availability.toLowerCase();
    product.in_stock = availLower.includes('in stock') || availLower.includes('有货') || availLower.includes('在庫');
  }

  // 加购按钮
  product.can_add_to_cart = $('#add-to-cart-button').length > 0;
  product.can_buy_now = $('#buy-now-button').length > 0;

  // 评分
  const ratingElem = $('#acrPopover, span[data-hook="rating-out-of-text"]').first();
  if (ratingElem.length) {
    product.rating = ratingElem.attr('title') || ratingElem.text().trim();
  }

  const ratingValueElem = $('span.a-icon-alt').first();
  if (ratingValueElem.length) {
    product.rating_value = parseFloat(ratingValueElem.text().trim().split(' ')[0]) || null;
  }

  // 评论数
  const reviewCountElem = $('#acrCustomerReviewText, #revCount').first();
  if (reviewCountElem.length) {
    product.review_count = reviewCountElem.text().trim();
  }

  // 特性列表
  const featureBullets = $('#feature-bullets .a-list-item, #feature-bullets-btf .a-list-item');
  product.features = [];
  featureBullets.each((i, el) => {
    const text = $(el).text().trim();
    if (text) product.features.push(text);
  });

  // 描述
  const descriptionElem = $('#productDescription, #productDescription p').first();
  if (descriptionElem.length) {
    product.description = descriptionElem.text().trim();
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.description) {
        product.description = productData.description;
      }
    }
  }

  // 描述图片
  const detailImages = [];
  $('#aplus img, #productDescription img').each((i, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src') || '';
    if (src && !src.includes('sprite') && !src.includes('grey-pixel')) {
      detailImages.push(src);
    }
  });
  product.description_images = [...new Set(detailImages)];

  // 技术详情（多个Amazon页面ID备选）
  const techDetailSelectors = [
    '#productDetails_techSpec_section_1',
    '#productDetails_techSpec_section_2',
    '#productDetails_techSpec_section_3',
    '#techSpec_section_1',
    '#productSpecifications',
    '.tech-specs',
    '#productDetails_db_sections',
    '#product_details_tabs',
  ];
  product.tech_details = {};
  for (const sel of techDetailSelectors) {
    const techDetails = $(sel).first();
    if (techDetails.length) {
      techDetails.find('tr').each((i, row) => {
        const key = $(row).find('th').text().trim();
        const value = $(row).find('td').text().trim();
        if (key && !product.tech_details[key]) {
          product.tech_details[key] = value;
        }
      });
      if (Object.keys(product.tech_details).length > 0) break;
    }
  }
  if (Object.keys(product.tech_details).length === 0) {
    // 正则后备：直接从原始HTML提取技术详情（不依赖DOM结构）
    const techHtmlMatch = html.match(/<div[^>]*id="productDetails_techSpec_section_1"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (techHtmlMatch) {
      const techHtml = techHtmlMatch[1];
      const trRegex = /<tr[^>]*>(?:<th[^>]*>([\s\S]*?)<\/th>(?:\s*<td[^>]*>([\s\S]*?)<\/td>)?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRegex.exec(techHtml)) !== null) {
        const key = cheerio.load(trMatch[1]).text().trim();
        const value = trMatch[2] ? cheerio.load(trMatch[2]).text().trim() : '';
        if (key && value && !product.tech_details[key]) {
          product.tech_details[key] = value;
        }
      }
    }
  }
  if (Object.keys(product.tech_details).length === 0) delete product.tech_details;
  
  // 产品详情表格（使用 a-text-bold 定位标签，避免 cheerio 嵌套 span 问题）
  const detailTableSelectors = [
    '#detailBullets_feature_div',
    '#productDetails_detailBullets_sections1',
    '#productDetails_detailBullets_sections2',
    '#productDetails_detailBullets_sections3',
    '#productDetails_navInfo_sections',
    '#productDetails_db_sections',
    '#product-details-table',
    '.detail-bullets',
    '#detailBullets',
  ];
  product.detail_table = {};
  for (const sel of detailTableSelectors) {
    const detailTable = $(sel).first();
    if (detailTable.length) {
      // 尝试 table 格式 (tr/th/td)
      const rows = detailTable.find('tr');
      if (rows.length > 0) {
        rows.each((i, row) => {
          const key = $(row).find('th').text().trim().replace(/:$/, '');
          const value = $(row).find('td').text().trim();
          if (key && value && key.length < 100 && !product.detail_table[key]) {
            product.detail_table[key] = value;
          }
        });
      }
      // 尝试 list 格式 (li > span.a-text-bold + span)
      if (Object.keys(product.detail_table).length === 0) {
        detailTable.find('li').each((i, row) => {
          const labelSpan = $(row).find('span.a-text-bold, b, strong').first();
          if (labelSpan.length) {
            const key = labelSpan.text().trim().replace(/:$/, '').replace(/\s*‏\s*‎\s*/, '');
            const valueSpan = labelSpan.next('span');
            if (valueSpan.length) {
              const value = valueSpan.text().trim();
              if (key && value && key.length < 100 && !product.detail_table[key]) {
                product.detail_table[key] = value;
              }
            }
          }
        });
      }
      if (Object.keys(product.detail_table).length > 0) break;
    }
  }
  if (Object.keys(product.detail_table).length === 0) {
    // 正则后备：直接从原始HTML提取产品详情表（不依赖DOM结构）
    const detailHtmlMatch = html.match(/<div[^>]*id="productDetails_detailBullets_sections1"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (detailHtmlMatch) {
      const detailHtml = detailHtmlMatch[1];
      // 匹配 tr/th/td 格式
      const trRegex = /<tr[^>]*>(?:<th[^>]*>([\s\S]*?)<\/th>(?:\s*<td[^>]*>([\s\S]*?)<\/td>)?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRegex.exec(detailHtml)) !== null) {
        const key = cheerio.load(trMatch[1]).text().trim().replace(/:$/, '');
        const value = trMatch[2] ? cheerio.load(trMatch[2]).text().trim() : '';
        if (key && value && key.length < 100 && !product.detail_table[key]) {
          product.detail_table[key] = value;
        }
      }
      // 匹配 li/span 格式
      if (Object.keys(product.detail_table).length === 0) {
        const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let liMatch;
        while ((liMatch = liRegex.exec(detailHtml)) !== null) {
          const liHtml = liMatch[1];
          const labelMatch = liHtml.match(/<span[^>]*class="[^"]*a-text-bold[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
          if (labelMatch) {
            const key = cheerio.load(labelMatch[1]).text().trim().replace(/:$/, '').replace(/\s*‏\s*‎\s*/, '');
            const valueMatch = liHtml.match(/<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
            const value = valueMatch ? cheerio.load(valueMatch[1]).text().trim() : '';
            if (key && value && key.length < 100 && !product.detail_table[key]) {
              product.detail_table[key] = value;
            }
          }
        }
      }
    }
  }
  if (Object.keys(product.detail_table).length === 0) delete product.detail_table;

  // 主图
  const mainImageElem = $('#landingImage, #main-image').first();
  if (mainImageElem.length) {
    product.main_image = mainImageElem.attr('data-old-hires') || mainImageElem.attr('data-hires') || mainImageElem.attr('src') || '';
  }

  // 缩略图
  const thumbnailImages = [];
  $('#altImages img, #imageBlock img, .a-button-text img').each((i, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-old-hires') || '';
    if (src && !src.includes('sprite') && !src.includes('grey-pixel') && !src.includes('pixel')) {
      thumbnailImages.push(src);
    }
  });
  product.images = [...new Set(thumbnailImages)];

  // 画廊图
  const galleryImages = [];
  $('#imageBlock img, #main-image-container img').each((i, img) => {
    const src = $(img).attr('data-old-hires') || $(img).attr('data-hires') || $(img).attr('src') || '';
    if (src && !src.includes('sprite') && !src.includes('grey-pixel')) {
      galleryImages.push(src);
    }
  });
  product.gallery_images = [...new Set(galleryImages)];

  if (product.main_image && !product.gallery_images.includes(product.main_image)) {
    product.gallery_images.unshift(product.main_image);
  }

  // SKU变体 - 多种方式提取
  const skuData = extractAllSkuData(html, $);
  product.sku_variants = skuData.variants;
  product.sku_count = skuData.variants.length;
  product.sku_dimensions = skuData.dimensions;
  product.sku_selection = skuData.selection;
  product.sku_preview = skuData.preview;
  product.sku_details = skuData.details;
  
  // 规格属性
  product.specifications = extractSpecifications($);
  if (product.specifications.length === 0 && product.detail_table) {
    // 后备：从detail_table转为specifications格式
    for (const [key, value] of Object.entries(product.detail_table)) {
      if (key && value && key.length < 100) {
        product.specifications.push({ key, value });
      }
    }
  }
  
  // 商品属性表格
  product.attributes = extractAttributes($);
  if (Object.keys(product.attributes).length === 0 && product.detail_table) {
    // 后备：从detail_table转为attributes格式
    for (const [key, value] of Object.entries(product.detail_table)) {
      if (key && value && key.length < 50) {
        product.attributes[key] = value;
      }
    }
  }

  // 关联商品
  const alsoBought = [];
  $('#sims-fbt .a-link-normal, .sims-fbt-reference, #sims-consolidated-1 .a-link-normal').each((i, el) => {
    const href = $(el).attr('href') || $(el).parent().attr('href') || '';
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
    if (asinMatch) alsoBought.push(asinMatch[1]);
  });
  product.also_bought = [...new Set(alsoBought)];

  const alsoViewed = [];
  $('#sims-fbt-compare .a-link-normal, #comparison-cards .a-link-normal').each((i, el) => {
    const href = $(el).attr('href') || '';
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
    if (asinMatch) alsoViewed.push(asinMatch[1]);
  });
  product.also_viewed = [...new Set(alsoViewed)];

  // Prime标识
  product.is_prime = $('#pdp-obp-badge, i.a-icon-prime, .a-icon-prime, [data-prime], #badgePrime, #prime-badge, .prime-badge').length > 0;

  // 卖家信息
  const sellerSelectors = [
    '#merchant-info a', '#tabular-buybox .tabular-buybox-text a',
    '#merchant-info', '.tabular-buybox-trademark .seller-name', '#sellerProfileTriggerId',
  ];
  for (const sel of sellerSelectors) {
    const sellerElem = $(sel).first();
    if (sellerElem.length) {
      const text = sellerElem.text().trim();
      if (text) {
        product.seller = text;
        break;
      }
    }
  }

  // Buybox卖家
  const buyboxSelectors = ['#tabular-buybox .tabular-buybox-text', '#merchant-info .tabular-buybox-text', '.tabular-buybox'];
  for (const sel of buyboxSelectors) {
    const buyboxElem = $(sel).first();
    if (buyboxElem.length) {
      const text = buyboxElem.text().trim();
      if (text) {
        product.buybox_seller = text;
        break;
      }
    }
  }

  // 销售方/配送方
  const soldByElem = $('#merchant-info .seller-name, .tabular-buybox-trademark .seller-name').first();
  if (soldByElem.length) {
    product.sold_by = soldByElem.text().trim();
  }

  const fulfilledByElem = $('#merchant-info .fulfillment, .tabular-buybox-trademark .fulfillment').first();
  if (fulfilledByElem.length) {
    product.fulfilled_by = fulfilledByElem.text().trim();
  }

  // ==================== 新增字段 ====================

  // SKU (Item model number / Manufacturer part number)
  // 策略：LD+JSON > detail_table > tech_details > DOM遍历，找不到则为null
  product.sku = null;

  // 1) 优先从LD+JSON提取（最可靠）
  const ldJsonSku = extractLdJson(html);
  if (ldJsonSku.length > 0) {
    const productData = ldJsonSku.find(item => item['@type'] === 'Product');
    if (productData) {
      product.sku = productData.sku || productData.mpn || productData.model || null;
    }
  }

  // 2) 从detail_table中提取（备用）
  if (!product.sku && product.detail_table) {
    const skuKeys = ['Item model number', 'SKU', 'Model Number', 'Model', 'Model Number:', 'Part Number', 'Model #', 'Manufacturer part number', 'ASIN', 'UPC', 'EAN'];
    for (const key of skuKeys) {
      if (product.detail_table[key]) {
        product.sku = product.detail_table[key];
        break;
      }
    }
  }

  // 3) 从tech_details中提取（备用）
  if (!product.sku && product.tech_details) {
    const skuKeys = ['Item model number', 'SKU', 'Model Number', 'Model', 'Part Number', 'Model #'];
    for (const key of skuKeys) {
      if (product.tech_details[key]) {
        product.sku = product.tech_details[key];
        break;
      }
    }
  }

  // 4) 从DOM遍历提取（使用 a-text-bold + next() 避免嵌套问题）
  if (!product.sku) {
    const skuKeywords = ['item model number', 'sku', 'model number', 'part number', 'model #', 'manufacturer'];
    const detailRows = $('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #detailBullets_feature_div li, #productDetails_db_sections tr');
    detailRows.each((i, row) => {
      // 尝试 table 格式 (tr > th + td)
      const labelTh = $(row).find('th').text().trim().toLowerCase().replace(/:$/, '');
      if (labelTh && skuKeywords.some(k => labelTh.includes(k))) {
        const value = $(row).find('td').text().trim();
        if (value) { product.sku = value; return false; }
      }
      // 尝试 list 格式 (li > span.a-list-item > span.a-text-bold + span)
      const labelSpan = $(row).find('span.a-text-bold').first();
      if (labelSpan.length) {
        const label = labelSpan.text().trim().toLowerCase().replace(/:$/, '').replace(/\s*‏\s*‎\s*/, '');
        if (skuKeywords.some(k => label.includes(k))) {
          const valueSpan = labelSpan.next('span');
          if (valueSpan.length) {
            const value = valueSpan.text().trim();
            if (value) { product.sku = value; return false; }
          }
        }
      }
    });
  }

  // 5) 从原始HTML正则提取（最可靠的后备方案，不依赖DOM结构）
  if (!product.sku) {
    const skuRegex = /(?:Item model number|SKU|Model Number|Part Number|Model\s*#|Manufacturer part number)\s*(?::|<\/th>\s*<td[^>]*>)\s*([^<]+)/i;
    const skuMatch = html.match(skuRegex);
    if (skuMatch && skuMatch[1]) {
      product.sku = skuMatch[1].trim();
    }
  }

  // 分类路径 (breadcrumb)
  const breadcrumbElem = $('#wayfinding-breadcrumbs_container ul.a-unordered-list, #breadcrumb li, .a-breadcrumb li, #wayfinding-breadcrumbs_feature_div li');
  if (breadcrumbElem.length) {
    const categories = [];
    breadcrumbElem.each((i, el) => {
      const text = $(el).text().trim();
      if (text && text !== '›' && text !== '›') {
        categories.push(text.replace(/[›\s]+/g, '').trim());
      }
    });
    product.category = categories.filter(c => c).join(' > ');
    product.category_path = categories.filter(c => c);
  }

  // Best Sellers Rank（cheerio不支持:contains，改用filter遍历）
  const bsrKeywords = ['best sellers rank', 'best seller rank', '商品排名', '销售排名'];
  const bsrRows = $('#productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, #productDetails_db_sections tr, .detail-bullets li');
  bsrRows.each((i, row) => {
    const text = $(row).text().trim().toLowerCase();
    if (bsrKeywords.some(k => text.includes(k))) {
      product.best_sellers_rank = $(row).text().trim();
      const rankMatch = product.best_sellers_rank.match(/#([\d,]+)/);
      if (rankMatch) {
        product.best_sellers_rank_value = parseInt(rankMatch[1].replace(/,/g, ''));
      }
      return false;
    }
  });

  // "About this item" bullet points（复用features，避免重复提取）
  if (product.features && product.features.length > 0) {
    product.bullet_points = [...product.features];
  }

  // Date First Available
  if (product.detail_table) {
    const dateKeys = ['Date First Available', 'Date First Available:', '上市日期'];
    for (const key of dateKeys) {
      if (product.detail_table[key]) {
        product.date_first_available = product.detail_table[key];
        break;
      }
    }
  }

  // Manufacturer
  if (product.detail_table) {
    const mfrKeys = ['Manufacturer', 'Manufacturer:', '品牌', 'Brand'];
    for (const key of mfrKeys) {
      if (product.detail_table[key] && product.detail_table[key] !== product.brand) {
        product.manufacturer = product.detail_table[key];
        break;
      }
    }
  }
  if (!product.manufacturer) {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.manufacturer) {
        product.manufacturer = productData.manufacturer.name || productData.manufacturer;
      }
    }
  }

  // Product Dimensions & Weight
  if (product.detail_table) {
    const dimKey = ['Product Dimensions', 'Item Dimensions', 'Dimensions', 'Package Dimensions', '产品尺寸'];
    for (const key of dimKey) {
      if (product.detail_table[key]) {
        product.dimensions = product.detail_table[key];
        break;
      }
    }
    const weightKey = ['Item Weight', 'Weight', 'Product Weight', 'Package Weight', '商品重量'];
    for (const key of weightKey) {
      if (product.detail_table[key]) {
        product.weight = product.detail_table[key];
        break;
      }
    }
  }

  // Video URL
  const videoElem = $('video[data-video-url], #video-tricker video, [data-video-url]').first();
  if (videoElem.length) {
    product.video_url = videoElem.attr('data-video-url') || videoElem.attr('src') || '';
  }
  if (!product.video_url) {
    $('#video-tricker video source, #video-tricker-tricker video source').each((i, source) => {
      const src = $(source).attr('src') || '';
      if (src && !product.video_url) {
        product.video_url = src;
      }
    });
  }
  // 从LD+JSON中提取视频
  if (!product.video_url) {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.video) {
        product.video_url = productData.video.contentUrl || productData.video.embedUrl || '';
      }
    }
  }

  // Coupon信息
  const couponElem = $('#couponText, .promoTextBlock, .coupon-badge, .deal-badge, [data-coupon]').first();
  if (couponElem.length) {
    product.coupon = couponElem.text().trim();
  }
  if (!product.coupon) {
    const couponRegex = /Coupon.*?(\d+%|\$[\d.]+)/i;
    const couponMatch = html.match(couponRegex);
    if (couponMatch) {
      product.coupon = couponMatch[0].trim();
    }
  }

  // Deal/Lightning Deal信息
  const dealElem = $('.deal-price, .dealBadge, .deal-price-label, #dealBadge, #priceblock_dealprice').first();
  if (dealElem.length) {
    const dealText = dealElem.text().trim();
    if (dealText) {
      product.deal_info = dealText;
    }
  }
  // 检查是否有闪电特价
  const lightningDealBadge = $('.deal-share-badge, .gb-font-lighting-deal, .a-deal-badge, .badgeText').filter((i, el) => $(el).text().includes('Deal')).first();
  if (lightningDealBadge.length) {
    product.is_deal = true;
    product.deal_type = 'Lightning Deal';
  }
  // 检查促销
  const promotionElem = $('#promoPriceBlockMessage, #promoMessage, .promoPriceBlockMessage').first();
  if (promotionElem.length) {
    product.promotion = promotionElem.text().trim();
  }

  // 订阅折扣 (Subscribe & Save)
  const sasElem = $('.a-price-savings, .sns-promotion, #sns-promotion, [data-sns-promotion]').filter((i, el) => $(el).text().includes('Subscribe')).first();
  if (sasElem.length || html.includes('Subscribe & Save') || html.includes('subscribe-and-save')) {
    product.subscribe_and_save = true;
    const sasText = sasElem.length ? sasElem.text().trim() : '';
    if (sasText) {
      product.subscribe_save_discount = sasText;
    }
  }

  // 退货政策
  const returnElem = $('#returns-policy, #return-policy, .a-expander-content, [data-feature-name="return-policy"]').filter((i, el) => $(el).text().includes('Return')).first();
  if (returnElem.length) {
    product.return_policy = returnElem.text().trim().substring(0, 500);
  }

  // 商品数量/包装数量
  if (product.detail_table) {
    const countKeys = ['Item Quantity', 'Number of Items', 'Count', 'Packaging Quantity', '数量'];
    for (const key of countKeys) {
      if (product.detail_table[key]) {
        product.item_count = product.detail_table[key];
        break;
      }
    }
  }

  // 商品所在大类
  const departmentElem = $('#nav-subnav, #departments, #searchDropdownBox option[selected], .nav-search-label').first();
  if (departmentElem.length) {
    product.department = departmentElem.text().trim();
  }

  return product;
}

function extractAllSkuData(html, $) {
  const result = {
    variants: [],
    dimensions: [],
    selection: null,
    preview: null,
    details: []
  };
  
  const seenAsins = new Set();
  
  // 方式1: 从JSON数据中提取
  extractFromJsonData(html, result, seenAsins);
  
  // 方式2: 从twister选择器提取
  extractFromTwister($, result, seenAsins);
  
  // 方式3: 从image-displayed SKU提取
  extractFromImageDisplayed($, result, seenAsins);
  
  // 方式4: 从JavaScript变量提取
  extractFromJsVariables(html, result, seenAsins);
  
  // 方式5: 从variation_parts提取
  extractFromVariationParts($, result, seenAsins);
  
  // 方式6: 从HTML数据属性提取（最可靠，不依赖DOM结构）
  extractFromDataAttributes(html, result, seenAsins);
  
  // 提取SKU详情
  if (result.variants.length > 0) {
    result.details = extractSkuDetails(html, $, result.variants);
  }
  
  return result;
}

function extractFromJsonData(html, result, seenAsins) {
  try {
    const patterns = [
      { regex: /"variationDisplayLabels":\s*(\[[\s\S]*?\])/, type: 'labels' },
      { regex: /"dimensionValuesDisplayData":\s*(\{[\s\S]*?\})/, type: 'dimensions' },
      { regex: /"variationLabels":\s*(\[[\s\S]*?\])/, type: 'labels' },
      { regex: /"skuSelection":\s*(\[[\s\S]*?\])/, type: 'selection' },
      { regex: /"skuPreview":\s*(\[[\s\S]*?\])/, type: 'preview' },
      { regex: /"item\.skus":\s*(\[[\s\S]*?\])/, type: 'skus' },
      { regex: /"result\.skus":\s*(\[[\s\S]*?\])/, type: 'skus' },
      { regex: /"detailData\.skus":\s*(\[[\s\S]*?\])/, type: 'skus' },
      { regex: /"variationValues"\s*:\s*(\{[\s\S]*?\})\s*[,}]/, type: 'variationValues' },
      { regex: /"parentAsin"\s*:\s*"([A-Z0-9]{10})"/, type: 'parentAsin' },
      { regex: /"childAsins"\s*:\s*(\[[\s\S]*?\])/, type: 'childAsins' },
    ];

    for (const { regex, type } of patterns) {
      const match = html.match(regex);
      if (!match) continue;
      
      try {
        const data = JSON.parse(match[1]);
        
        if (type === 'selection') {
          result.selection = data;
        } else if (type === 'preview') {
          result.preview = data;
        }
        
        if (Array.isArray(data)) {
          parseArrayData(data, result, seenAsins, type);
        } else if (typeof data === 'object') {
          parseObjectData(data, result, seenAsins, type);
        }
      } catch {
        // ignore parse errors
      }
    }
  } catch {
    // ignore
  }
}

function parseArrayData(data, result, seenAsins, type) {
  for (const item of data) {
    if (typeof item === 'object') {
      const asin = item.defaultAsin || item.asin || item.sku || '';
      if (asin && /^[A-Z0-9]{10}$/i.test(asin) && !seenAsins.has(asin)) {
        seenAsins.add(asin);
        result.variants.push({
          asin,
          title: item.displayLabel || item.label || item.title || '',
          image: item.image || item.imageUrl || '',
          price: item.price || item.salePrice || '',
          attributes: item.attributes || item.variationAttributes || [],
          sku_data: item
        });
      }
    } else if (typeof item === 'string' && /^[A-Z0-9]{10}$/i.test(item) && !seenAsins.has(item)) {
      seenAsins.add(item);
      result.variants.push({ asin: item });
    }
  }
}

function parseObjectData(data, result, seenAsins, type) {
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && /^[A-Z0-9]{10}$/i.test(item) && !seenAsins.has(item)) {
          seenAsins.add(item);
          result.variants.push({ asin: item, dimension: key });
        } else if (typeof item === 'object') {
          const asin = item.defaultAsin || item.asin || '';
          if (asin && !seenAsins.has(asin)) {
            seenAsins.add(asin);
            result.variants.push({
              asin,
              title: item.displayLabel || item.label || '',
              image: item.image || '',
              dimension: key
            });
          }
        }
      }
    }
  }
}

function extractFromTwister($, result, seenAsins) {
  // 解析twister维度选择器
  const twisterDims = $('#twister .twister-dim, [data-dimension-name], .twisterDimension');
  const dimensions = [];
  
  twisterDims.each((i, dim) => {
    const dimName = $(dim).attr('data-dimension-name') || $(dim).attr('aria-label') || $(dim).find('.a-row').first().text().trim() || '';
    const variants = [];
    
    $(dim).find('.a-button-text, a[href*="/dp/"], .twister-attr').each((j, btn) => {
      const href = $(btn).attr('href') || '';
      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
      const asin = asinMatch ? asinMatch[1] : ($(btn).attr('data-asin') || '');
      const label = $(btn).attr('aria-label') || $(btn).text().trim() || '';
      const image = $(btn).find('img').attr('src') || $(btn).find('img').attr('data-src') || '';
      
      if (asin && /^[A-Z0-9]{10}$/i.test(asin) && !seenAsins.has(asin)) {
        seenAsins.add(asin);
        const variant = { asin, title: label, image };
        result.variants.push(variant);
        variants.push({ asin, label });
      } else if (label && !asin) {
        variants.push({ label });
      }
    });
    
    if (dimName && variants.length > 0) {
      dimensions.push({ dimension: dimName, variants });
    }
  });
  
  if (dimensions.length > 0) {
    result.dimensions = dimensions;
  }
  
  // 备用: 从twister中提取所有链接
  $('#twister a[href*="/dp/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
    if (asinMatch && !seenAsins.has(asinMatch[1])) {
      seenAsins.add(asinMatch[1]);
      result.variants.push({
        asin: asinMatch[1],
        title: $(el).text().trim(),
        image: $(el).find('img').attr('src') || ''
      });
    }
  });
}

function extractFromImageDisplayed($, result, seenAsins) {
  // 从图片显示区域提取SKU
  $('img[data-asin], .image-displayed [data-asin]').each((i, img) => {
    const asin = $(img).attr('data-asin') || '';
    if (asin && /^[A-Z0-9]{10}$/i.test(asin) && !seenAsins.has(asin)) {
      seenAsins.add(asin);
      result.variants.push({
        asin,
        image: $(img).attr('src') || $(img).attr('data-old-hires') || ''
      });
    }
  });
}

function extractFromJsVariables(html, result, seenAsins) {
  try {
    // 提取pageData或context中的SKU数据
    const jsPatterns = [
      /pageData\s*=\s*(\{[\s\S]*?\});/,
      /context\s*=\s*(\{[\s\S]*?\});/,
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
      /"currentAsin"\s*:\s*"([A-Z0-9]{10})"/g,
    ];
    
    for (const pattern of jsPatterns) {
      const matches = [...html.matchAll(pattern)];
      for (const match of matches) {
        if (match[1]) {
          const value = match[1].trim();
          if (/^[A-Z0-9]{10}$/i.test(value) && !seenAsins.has(value)) {
            seenAsins.add(value);
            result.variants.push({ asin: value, is_current: true });
          }
        }
      }
    }
    
    // 提取所有ASIN引用
    const asinRegex = /["']asin["']\s*:\s*["']([A-Z0-9]{10})["']/g;
    let asinMatch;
    while ((asinMatch = asinRegex.exec(html)) !== null) {
      const asin = asinMatch[1];
      if (!seenAsins.has(asin)) {
        seenAsins.add(asin);
        result.variants.push({ asin });
      }
    }
  } catch {
    // ignore
  }
}

function extractFromVariationParts($, result, seenAsins) {
  // 从variation_parts提取
  $('.variation_parts a, .variation_selector a, [class*="variation"] a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i) || href.match(/[?&]asin=([A-Z0-9]{10})/i);
    if (asinMatch && !seenAsins.has(asinMatch[1])) {
      seenAsins.add(asinMatch[1]);
      result.variants.push({
        asin: asinMatch[1],
        title: $(el).text().trim(),
        image: $(el).find('img').attr('src') || ''
      });
    }
  });
  
  // 从选择器选项提取
  $('select[id*="variation"], select[id*="sku"] option').each((i, opt) => {
    const value = $(opt).attr('value') || '';
    const asinMatch = value.match(/([A-Z0-9]{10})/i);
    if (asinMatch && !seenAsins.has(asinMatch[1])) {
      seenAsins.add(asinMatch[1]);
      result.variants.push({
        asin: asinMatch[1],
        title: $(opt).text().trim()
      });
    }
  });
}

function extractFromDataAttributes(html, result, seenAsins) {
  try {
    // 方式1: data-default-asin 属性（Amazon标准格式）
    const defaultAsinRegex = /data-default-asin\s*=\s*["']([A-Z0-9]{10})["']/gi;
    let match;
    while ((match = defaultAsinRegex.exec(html)) !== null) {
      if (!seenAsins.has(match[1])) {
        seenAsins.add(match[1]);
        result.variants.push({ asin: match[1], source: 'data-default-asin' });
      }
    }
    
    // 方式2: data-asin 属性（图片/按钮上的变体ASIN）
    const dataAsinRegex = /data-asin\s*=\s*["']([A-Z0-9]{10})["']/gi;
    while ((match = dataAsinRegex.exec(html)) !== null) {
      if (!seenAsins.has(match[1])) {
        seenAsins.add(match[1]);
        result.variants.push({ asin: match[1], source: 'data-asin' });
      }
    }
    
    // 方式3: data-image-url 属性（变体图片URL）
    const imageUrlRegex = /data-image-url\s*=\s*["']([^"']+)["']/gi;
    const imageUrlMap = new Map();
    while ((match = imageUrlRegex.exec(html)) !== null) {
      if (match[1]) {
        const url = match[1].trim();
        const before = html.substring(0, match.index);
        const nearbyAsin = before.match(/data-(?:default-)?asin\s*=\s*["']([A-Z0-9]{10})["'][^]*$/);
        if (nearbyAsin && !imageUrlMap.has(nearbyAsin[1])) {
          imageUrlMap.set(nearbyAsin[1], url);
        }
      }
    }
    if (imageUrlMap.size > 0) {
      for (const variant of result.variants) {
        if (imageUrlMap.has(variant.asin) && !variant.image) {
          variant.image = imageUrlMap.get(variant.asin);
        }
      }
    }
    
    // 方式4: 从colorImages JSON数据提取
    const colorImagesRegex = /colorImages\s*:\s*(\{[\s\S]*?\})\s*,\s*colorImages/;
    const colorImagesMatch = html.match(colorImagesRegex);
    if (colorImagesMatch) {
      try {
        const colorData = JSON.parse(colorImagesMatch[1]);
        for (const [color, images] of Object.entries(colorData)) {
          if (Array.isArray(images) && images.length > 0) {
            const firstImage = images[0];
            const asin = firstImage.asin || (firstImage.main && firstImage.main.asin) || '';
            const imageUrl = (firstImage.main && firstImage.main.url) || firstImage.url || '';
            if (asin && !seenAsins.has(asin)) {
              seenAsins.add(asin);
              result.variants.push({ asin, title: color, image: imageUrl || '', source: 'colorImages' });
            }
          }
        }
      } catch {}
    }
    
    // 方式5: 从data-a-input-name提取变体标签
    const attrRegex = /data-a-input-name\s*=\s*["']([^"']+)["'][^>]*data-a-id-for-attribute\s*=\s*["']([^"']+)["']/gi;
    while ((match = attrRegex.exec(html)) !== null) {
      const before = html.substring(0, match.index);
      const nearbyAsin = before.match(/data-(?:default-)?asin\s*=\s*["']([A-Z0-9]{10})["'][^]*$/);
      if (nearbyAsin && !seenAsins.has(nearbyAsin[1])) {
        seenAsins.add(nearbyAsin[1]);
        result.variants.push({ asin: nearbyAsin[1], title: match[2], attribute: match[1], source: 'data-attribute' });
      }
    }
    
    // 方式6: 从dimensionValuesDisplayData JSON提取
    const dimensionRegex = /"dimensionValuesDisplayData"\s*:\s*\{([\s\S]*?)(?:"\s*,\s*"[a-z]|"variationValues")/i;
    const dimMatch = html.match(dimensionRegex);
    if (dimMatch) {
      try {
        const dimData = JSON.parse('{' + dimMatch[1] + '}');
        for (const [key, values] of Object.entries(dimData)) {
          if (typeof values === 'object' && values.title) {
            const asinPattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*?"asin"\\s*:\\s*"([A-Z0-9]{10})"`, 'i');
            const asinMatch = html.match(asinPattern);
            if (asinMatch && !seenAsins.has(asinMatch[1])) {
              seenAsins.add(asinMatch[1]);
              result.variants.push({ asin: asinMatch[1], title: values.title, image: values.imageUrl || '', source: 'dimensionValues' });
            }
          }
        }
      } catch {}
    }
  } catch {
    // ignore
  }
}

function extractSkuDetails(html, $, variants) {
  const details = [];
  
  for (const variant of variants.slice(0, 5)) {
    const skuDetail = {
      asin: variant.asin,
      title: variant.title || '',
      image: variant.image || '',
      url: `https://www.amazon.com/dp/${variant.asin}`
    };
    
    // 从JSON数据获取价格
    try {
      const pricePatterns = [
        new RegExp(`"[^"]*price[^"]*"\\s*:\\s*\\{[^}]*"amount"\\s*:\\s*([\\d.]+)[^}]*"asin"\\s*:\\s*"${variant.asin}"`, 'i'),
        new RegExp(`"asin"\\s*:\\s*"${variant.asin}"[^}]*"salePrice"\\s*:\\s*([\\d.]+)`, 'i'),
        new RegExp(`"asin"\\s*:\\s*"${variant.asin}"[^}]*"discountPrice"\\s*:\\s*([\\d.]+)`, 'i'),
      ];
      
      for (const pattern of pricePatterns) {
        const match = html.match(pattern);
        if (match) {
          skuDetail.price = parseFloat(match[1]);
          break;
        }
      }
      
      // 获取库存信息
      const stockPattern = new RegExp(`"asin"\\s*:\\s*"${variant.asin}"[^}]*"availability"\\s*:\\s*"([^"]+)"`, 'i');
      const stockMatch = html.match(stockPattern);
      if (stockMatch) {
        skuDetail.availability = stockMatch[1];
        skuDetail.in_stock = stockMatch[1].toLowerCase().includes('in stock');
      }
      
      // 获取规格属性
      const specPattern = new RegExp(`"asin"\\s*:\\s*"${variant.asin}"[\\s\\S]*?"specAttrs"\\s*:\\s*(\\[[\\s\\S]*?\\])`, 'i');
      const specMatch = html.match(specPattern);
      if (specMatch) {
        try {
          skuDetail.spec_attrs = JSON.parse(specMatch[1]);
        } catch {
          // ignore
        }
      }
      
      // 获取评论数
      const reviewPattern = new RegExp(`"asin"\\s*:\\s*"${variant.asin}"[\\s\\S]*?"saleCount"\\s*:\\s*(\\d+)`, 'i');
      const reviewMatch = html.match(reviewPattern);
      if (reviewMatch) {
        skuDetail.sale_count = parseInt(reviewMatch[1]);
      }
      
      // 可预订数量
      const bookPattern = new RegExp(`"asin"\\s*:\\s*"${variant.asin}"[\\s\\S]*?"canBookCount"\\s*:\\s*(\\d+)`, 'i');
      const bookMatch = html.match(bookPattern);
      if (bookMatch) {
        skuDetail.can_book_count = parseInt(bookMatch[1]);
      }
      
    } catch {
      // ignore
    }
    
    // 从DOM获取SKU相关元素
    const skuElement = $(`[data-asin="${variant.asin}"]`).first();
    if (skuElement.length) {
      skuElement.find('img').each((i, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        if (src && !skuDetail.images) skuDetail.images = [];
        if (src) skuDetail.images.push(src);
      });
    }
    
    details.push(skuDetail);
  }
  
  return details;
}

function extractSpecifications($) {
  const specs = [];
  const seenKeys = new Set();
  
  const specSelectors = [
    '#detailBullets_feature_div li',
    '#productDetails_detailBullets_sections1 tr',
    '#productDetails_db_sections tr',
    '#productDetails_navInfo_sections tr',
    '.detail-bullets li',
    '#productSpecifications tr',
  ];
  
  for (const sel of specSelectors) {
    $(sel).each((i, el) => {
      // table tr 格式 (th + td)
      const keyTh = $(el).find('th');
      const valueTd = $(el).find('td');
      if (keyTh.length && valueTd.length) {
        const key = keyTh.text().trim().replace(/:$/, '');
        const value = valueTd.text().trim();
        if (key && value && key !== '\u200f' && key.length < 100 && !seenKeys.has(key)) {
          seenKeys.add(key);
          specs.push({ key, value });
        }
        return;
      }
      // li span 格式 (li > span.a-list-item > span.a-text-bold + span)
      const labelSpan = $(el).find('span.a-text-bold').first();
      if (labelSpan.length) {
        const key = labelSpan.text().trim().replace(/:$/, '').replace(/\s*‏\s*‎\s*/, '');
        const valueSpan = labelSpan.next('span');
        if (valueSpan.length) {
          const value = valueSpan.text().trim();
          if (key && value && key !== '\u200f' && key.length < 100 && !seenKeys.has(key)) {
            seenKeys.add(key);
            specs.push({ key, value });
          }
        }
      }
    });
    if (specs.length > 0) break;
  }
  
  return specs;
}

function extractAttributes($) {
  const attributes = {};
  
  const attrSelectors = [
    '#detailBullets_feature_div li',
    '#productDetails_detailBullets_sections1 tr',
    '#productDetails_db_sections tr',
    '#productDetails_navInfo_sections tr',
    '.detail-bullets li',
    '#productSpecifications tr',
  ];
  
  for (const sel of attrSelectors) {
    $(sel).each((i, el) => {
      // table tr 格式 (th + td)
      const keyTh = $(el).find('th:first');
      const valueTd = $(el).find('td:first');
      if (keyTh.length && valueTd.length) {
        const key = keyTh.text().trim().replace(/:$/, '');
        const value = valueTd.text().trim();
        if (key && value && key.length < 50 && !attributes[key]) {
          attributes[key] = value;
        }
        return;
      }
      // li span 格式 (li > span.a-list-item > span.a-text-bold + span)
      const labelSpan = $(el).find('span.a-text-bold').first();
      if (labelSpan.length) {
        const key = labelSpan.text().trim().replace(/:$/, '').replace(/\s*‏\s*‎\s*/, '');
        const valueSpan = labelSpan.next('span');
        if (valueSpan.length) {
          const value = valueSpan.text().trim();
          if (key && value && key.length < 50 && !attributes[key]) {
            attributes[key] = value;
          }
        }
      }
    });
    if (Object.keys(attributes).length > 0) break;
  }
  
  return attributes;
}

module.exports = { searchProducts, getProductDetail };

