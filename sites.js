const SITES = {
  'com': { domain: 'www.amazon.com', country: 'US', currency: 'USD', language: 'en' },
  'co.cn': { domain: 'www.amazon.cn', country: 'CN', currency: 'CNY', language: 'zh' },
  'jp': { domain: 'www.amazon.co.jp', country: 'JP', currency: 'JPY', language: 'ja' },
  'de': { domain: 'www.amazon.de', country: 'DE', currency: 'EUR', language: 'de' },
  'co.uk': { domain: 'www.amazon.co.uk', country: 'GB', currency: 'GBP', language: 'en' },
  'fr': { domain: 'www.amazon.fr', country: 'FR', currency: 'EUR', language: 'fr' },
  'it': { domain: 'www.amazon.it', country: 'IT', currency: 'EUR', language: 'it' },
  'es': { domain: 'www.amazon.es', country: 'ES', currency: 'EUR', language: 'es' },
  'ca': { domain: 'www.amazon.ca', country: 'CA', currency: 'CAD', language: 'en' },
  'com.au': { domain: 'www.amazon.com.au', country: 'AU', currency: 'AUD', language: 'en' },
  'co.in': { domain: 'www.amazon.in', country: 'IN', currency: 'INR', language: 'en' },
  'com.br': { domain: 'www.amazon.com.br', country: 'BR', currency: 'BRL', language: 'pt' },
  'com.mx': { domain: 'www.amazon.com.mx', country: 'MX', currency: 'MXN', language: 'es' },
  'co.kr': { domain: 'www.amazon.co.kr', country: 'KR', currency: 'KRW', language: 'ko' },
  'co.sg': { domain: 'www.amazon.sg', country: 'SG', currency: 'SGD', language: 'en' },
  'ae': { domain: 'www.amazon.ae', country: 'AE', currency: 'AED', language: 'en' },
  'sa': { domain: 'www.amazon.sa', country: 'SA', currency: 'SAR', language: 'en' },
  'nl': { domain: 'www.amazon.nl', country: 'NL', currency: 'EUR', language: 'nl' },
  'se': { domain: 'www.amazon.se', country: 'SE', currency: 'SEK', language: 'sv' },
  'pl': { domain: 'www.amazon.pl', country: 'PL', currency: 'PLN', language: 'pl' },
  'eg': { domain: 'www.amazon.eg', country: 'EG', currency: 'EGP', language: 'en' },
};

function getSiteConfig(country) {
  return SITES[country] || null;
}

function getAllSiteKeys() {
  return Object.keys(SITES);
}

module.exports = { SITES, getSiteConfig, getAllSiteKeys };
