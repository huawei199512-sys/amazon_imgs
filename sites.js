const SITES = {
  'com': { domain: 'amazon.com', country: 'US', currency: 'USD', language: 'en', searchUrl: 'https://www.amazon.com/s', detailUrl: 'https://www.amazon.com/dp/' },
  'co.cn': { domain: 'amazon.cn', country: 'CN', currency: 'CNY', language: 'zh', searchUrl: 'https://www.amazon.cn/s', detailUrl: 'https://www.amazon.cn/dp/' },
  'jp': { domain: 'amazon.co.jp', country: 'JP', currency: 'JPY', language: 'ja', searchUrl: 'https://www.amazon.co.jp/s', detailUrl: 'https://www.amazon.co.jp/dp/' },
  'de': { domain: 'amazon.de', country: 'DE', currency: 'EUR', language: 'de', searchUrl: 'https://www.amazon.de/s', detailUrl: 'https://www.amazon.de/dp/' },
  'co.uk': { domain: 'amazon.co.uk', country: 'GB', currency: 'GBP', language: 'en', searchUrl: 'https://www.amazon.co.uk/s', detailUrl: 'https://www.amazon.co.uk/dp/' },
  'fr': { domain: 'amazon.fr', country: 'FR', currency: 'EUR', language: 'fr', searchUrl: 'https://www.amazon.fr/s', detailUrl: 'https://www.amazon.fr/dp/' },
  'it': { domain: 'amazon.it', country: 'IT', currency: 'EUR', language: 'it', searchUrl: 'https://www.amazon.it/s', detailUrl: 'https://www.amazon.it/dp/' },
  'es': { domain: 'amazon.es', country: 'ES', currency: 'EUR', language: 'es', searchUrl: 'https://www.amazon.es/s', detailUrl: 'https://www.amazon.es/dp/' },
  'ca': { domain: 'amazon.ca', country: 'CA', currency: 'CAD', language: 'en', searchUrl: 'https://www.amazon.ca/s', detailUrl: 'https://www.amazon.ca/dp/' },
  'com.au': { domain: 'amazon.com.au', country: 'AU', currency: 'AUD', language: 'en', searchUrl: 'https://www.amazon.com.au/s', detailUrl: 'https://www.amazon.com.au/dp/' },
  'co.in': { domain: 'amazon.in', country: 'IN', currency: 'INR', language: 'en', searchUrl: 'https://www.amazon.in/s', detailUrl: 'https://www.amazon.in/dp/' },
  'com.br': { domain: 'amazon.com.br', country: 'BR', currency: 'BRL', language: 'pt', searchUrl: 'https://www.amazon.com.br/s', detailUrl: 'https://www.amazon.com.br/dp/' },
  'com.mx': { domain: 'amazon.com.mx', country: 'MX', currency: 'MXN', language: 'es', searchUrl: 'https://www.amazon.com.mx/s', detailUrl: 'https://www.amazon.com.mx/dp/' },
  'co.kr': { domain: 'amazon.co.kr', country: 'KR', currency: 'KRW', language: 'ko', searchUrl: 'https://www.amazon.co.kr/s', detailUrl: 'https://www.amazon.co.kr/dp/' },
  'co.sg': { domain: 'amazon.sg', country: 'SG', currency: 'SGD', language: 'en', searchUrl: 'https://www.amazon.sg/s', detailUrl: 'https://www.amazon.sg/dp/' },
  'ae': { domain: 'amazon.ae', country: 'AE', currency: 'AED', language: 'en', searchUrl: 'https://www.amazon.ae/s', detailUrl: 'https://www.amazon.ae/dp/' },
  'sa': { domain: 'amazon.sa', country: 'SA', currency: 'SAR', language: 'en', searchUrl: 'https://www.amazon.sa/s', detailUrl: 'https://www.amazon.sa/dp/' },
  'nl': { domain: 'amazon.nl', country: 'NL', currency: 'EUR', language: 'nl', searchUrl: 'https://www.amazon.nl/s', detailUrl: 'https://www.amazon.nl/dp/' },
  'se': { domain: 'amazon.se', country: 'SE', currency: 'SEK', language: 'sv', searchUrl: 'https://www.amazon.se/s', detailUrl: 'https://www.amazon.se/dp/' },
  'pl': { domain: 'amazon.pl', country: 'PL', currency: 'PLN', language: 'pl', searchUrl: 'https://www.amazon.pl/s', detailUrl: 'https://www.amazon.pl/dp/' },
  'eg': { domain: 'amazon.eg', country: 'EG', currency: 'EGP', language: 'en', searchUrl: 'https://www.amazon.eg/s', detailUrl: 'https://www.amazon.eg/dp/' },
};
function getSiteConfig(country) {
  return SITES[country] || null;
}
function getAllSiteKeys() {
  return Object.keys(SITES);
}
module.exports = { SITES, getSiteConfig, getAllSiteKeys };