const cheerio = require('cheerio');

function isBlocked(html) {
  const patterns = [
    'Robot Check',
    'Enter the characters you see',
    "Sorry, we just need to make sure you're not a robot",
    'Sorry, you have been blocked',
    'captcha',
    'automated access',
    'request could not be processed',
  ];
  const lower = String(html).toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

function extractAsinFromUrl(url) {
  const m = String(url).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)
    || String(url).match(/[?&]asin=([A-Z0-9]{10})/i);
  return m ? m[1] : null;
}

function parseProducts(html, siteConfig) {
  const products = [];
  const $ = cheerio.load(html);
  const seen = new Set();

  $('div[data-asin]').each((i, el) => {
    try {
      const $item = $(el);
      const asin = $item.attr('data-asin');
      if (!asin || !/^[A-Z0-9]{10}$/i.test(asin) || seen.has(asin)) return;
      seen.add(asin);

      const product = {
        asin,
        domain: siteConfig.domain,
        detail_url: `https://${siteConfig.domain}/dp/${asin}`,
      };

      // 标题
      const titleElem = $item.find('h2 a span, h2 span, [data-cy="title-recipe"] span').first();
      product.title = titleElem.text().trim();

      // 链接（可能携带真实ASIN）
      const href = $item.find('h2 a').first().attr('href') || '';
      if (href) {
        try {
          product.full_url = new URL(href.startsWith('/') ? href : '/' + href, `https://${siteConfig.domain}`).toString();
        } catch { /* ignore */ }
        const realAsin = extractAsinFromUrl(href);
        if (realAsin && realAsin !== asin) {
          product.asin = realAsin;
          product.detail_url = `https://${siteConfig.domain}/dp/${realAsin}`;
        }
      }

      // 图片
      const img = $item.find('img.s-image, img[data-image-index]').first();
      if (img.length) {
        product.image_url = img.attr('src') || img.attr('data-src') || '';
        product.image_alt = img.attr('alt') || '';
      }

      // 价格
      const priceEl = $item.find('.a-price .a-offscreen').first();
      if (priceEl.length) {
        const display = priceEl.text().trim();
        const amountMatch = display.replace(/,/g, '').match(/[\d.]+/);
        product.price = { display, currency: siteConfig.currency };
        if (amountMatch) product.price.amount = parseFloat(amountMatch[0]);
      } else {
        product.price = null;
      }

      // 评分
      const ratingEl = $item.find('span.a-icon-alt').first();
      if (ratingEl.length) {
        product.rating = ratingEl.text().trim();
        product.rating_value = parseFloat(product.rating.split(' ')[0]) || null;
      }

      // 评论数
      const reviewEl = $item
        .find('span[aria-label*="stars"] + span a span, .a-size-small .a-link-normal .a-size-base, [data-cy="review-rating-information"] .a-size-base')
        .first();
      if (reviewEl.length) {
        const count = reviewEl.text().trim().replace(/,/g, '');
        if (count) product.review_count = count;
      }

      product.is_prime = $item.find('i.a-icon-prime, .a-icon-prime').length > 0;
      const sp = $item.find('span.a-color-secondary').filter((i2, s) => $(s).text().includes('Sponsored')).first();
      product.is_sponsored = sp.length > 0;

      if (product.title) products.push(product);
    } catch { /* 单卡片解析失败不影响整体 */ }
  });

  return products;
}

function extractTotalResults(html) {
  try {
    const $ = cheerio.load(html);
    const text = $('span[data-component-type="s-result-info-bar"] .sg-col-inner').first().text();
    const m = text.replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

// 从上传响应中提取“结果页跳转地址”，兼容 302 / JSON / HTML内嵌
function extractResultUrl(payload, headers, domain) {
  const base = `https://${domain}/`;

  // 1) 302 Location
  const loc = headers && (headers.location || headers.Location);
  if (loc) {
    const u = toAbs(loc, base);
    if (u) return u;
  }

  // 2) JSON 常见字段
  if (payload && typeof payload === 'object') {
    const keys = ['location', 'searchUrl', 'searchURL', 'resultsUrl', 'redirectUrl', 'redirect', 'url', 'link', 'href'];
    for (const k of keys) {
      if (typeof payload[k] === 'string' && payload[k].includes('/')) {
        const u = toAbs(payload[k], base);
        if (u) return u;
      }
    }
  }

  // 2.5) 响应是文本但内容实际为JSON（responseType:text时）
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const fromJson = extractResultUrl(parsed, null, domain);
        if (fromJson) return fromJson;
      } catch { /* 不是JSON，按文本处理 */ }
    }
  }

  // 3) HTML / 文本中的 /s 结果页链接
  const text = typeof payload === 'string' ? payload : safeStringify(payload);
  if (text) {
    const m = text.match(/https?:\/\/[^\s"'\\]+\/s[?][^\s"'\\]+/)
      || text.match(/["'`](\/s[?][^"'`\\]+)["'`]/);
    if (m) {
      const u = toAbs(m[1] || m[0], base);
      if (u) return u;
    }
    const m2 = text.match(/(?:location\.href|location\.replace)\(["'`]([^"'`]+)["'`]\)/);
    if (m2) {
      const u = toAbs(m2[1], base);
      if (u) return u;
    }
  }
  return null;
}

function toAbs(u, base) {
  try {
    const abs = new URL(u, base);
    if (!/^https?:$/.test(abs.protocol)) return null;
    return abs.toString();
  } catch {
    return null;
  }
}

function safeStringify(o) {
  try { return JSON.stringify(o); } catch { return ''; }
}

// ============ StyleSnap 图搜 JSON 解析 ============
// 响应：{queryId, searchResults:[{contentType:"BoundingBox", content:"sofa",
//   properties:{category,score,boundingBox:{tlx,tly,brx,bry,imageWidth,imageHeight}...},
//   bbxAsinList:[ASIN...], searchResultUrl:"/s?...", subContent:[{contentType:"ASIN",content:ASIN,properties:{score}}]}]}
const ASIN_RE = /^[A-Z0-9]{10}$/;

function isUnsupportedCategory(data) {
  try {
    const b = data && data.searchResults && data.searchResults[0];
    return !!(b && b.subContent && b.subContent.length === 1 &&
      b.subContent[0].content === 'stylesnap-unsupported-category');
  } catch { return false; }
}

function parseStyleSnap(data, siteConfig) {
  const boxes = Array.isArray(data && data.searchResults) ? data.searchResults : [];

  const detections = [];
  const productMap = new Map(); // asin -> product（保留首次出现，框按置信度排序）

  boxes.forEach((box, idx) => {
    const asins = Array.isArray(box.bbxAsinList) ? filterAsins(box.bbxAsinList) : [];

    // subContent 内有每个 ASIN 的图像匹配置信度
    const scoreMap = {};
    (box.subContent || []).forEach(n => {
      if (n && n.contentType === 'ASIN' && ASIN_RE.test(String(n.content))) {
        const s = n.properties && parseFloat(n.properties.score);
        scoreMap[n.content] = Number.isFinite(s) ? s : null;
      }
    });

    const bb = (box.properties && box.properties.boundingBox) || {};
    detections.push({
      box_index: idx,
      label: box.content || null,
      category: (box.properties && box.properties.category) || null,
      box_score: box.properties && box.properties.score ? parseFloat(box.properties.score) : null,
      bounding_box: {
        x: bb.tlx ?? bb.topLeftX ?? null,
        y: bb.tly ?? bb.topLeftY ?? null,
        width: bb.imageWidth ? (bb.brx - bb.tlx) / bb.imageWidth : null,
        height: bb.imageHeight ? (bb.bry - bb.tly) / bb.imageHeight : null,
        image_width: bb.imageWidth ?? null,
        image_height: bb.imageHeight ?? null,
      },
      asin_count: asins.length,
      result_url: box.searchResultUrl
        ? new URL(box.searchResultUrl, `https://${siteConfig.domain}/`).toString()
        : null,
    });

    asins.forEach(asin => {
      if (!productMap.has(asin)) {
        productMap.set(asin, {
          asin,
          domain: siteConfig.domain,
          detail_url: `https://${siteConfig.domain}/dp/${asin}`,
          matched_category: (box.properties && box.properties.category) || box.content || null,
          image_match_score: scoreMap[asin] ?? null,
        });
      }
    });
  });

  const products = [...productMap.values()]
    .sort((a, b) => (b.image_match_score ?? -1) - (a.image_match_score ?? -1));

  return {
    query_id: data.queryId || null,
    detections,
    products,
    total_results: products.length,
  };
}

function filterAsins(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const s = String(a);
    if (ASIN_RE.test(s) && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

module.exports = {
  isBlocked,
  parseProducts,
  extractTotalResults,
  extractResultUrl,
  extractAsinFromUrl,
  parseStyleSnap,
  isUnsupportedCategory,
};
