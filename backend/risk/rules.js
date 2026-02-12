/**
 * Risk detection rules for chat text and link signals.
 */

const SHORTENER_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'is.gd',
  'cutt.ly',
  'rebrand.ly',
  'ow.ly',
  'rb.gy',
  'shorturl.at',
]);

const SUSPICIOUS_TLDS = new Set(['top', 'xyz', 'zip', 'click', 'work', 'tokyo', 'rest', 'live']);
const SUSPICIOUS_HOST_PARTS = ['wallet', 'verify', 'gift', 'bonus', 'promo', 'airdrop', 'support'];

const ADS_KEYWORDS = [
  '兼职',
  '代刷',
  '刷单',
  '返利',
  '躺赚',
  '免费领',
  '推广',
  '代理',
  '优惠码',
  'telegram',
  'whatsapp',
  'vx',
  'buy now',
  'discount',
  'earn money',
];

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const IP_HOST_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const sanitizeText = (value, maxLen = 3000) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const extractUrls = (text) => {
  const safeText = sanitizeText(text);
  if (!safeText) return [];
  const hits = safeText.match(URL_RE);
  if (!Array.isArray(hits)) return [];
  return hits.slice(0, 8);
};

const getHostFromUrl = (rawUrl) => {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return String(url.hostname || '').toLowerCase();
  } catch {
    return '';
  }
};

const looksSuspiciousHost = (host) => {
  if (!host) return false;
  if (SHORTENER_HOSTS.has(host)) return true;
  if (host.includes('xn--')) return true;
  if (IP_HOST_RE.test(host)) return true;
  const tld = host.includes('.') ? host.split('.').pop() : '';
  if (tld && SUSPICIOUS_TLDS.has(tld)) return true;
  return SUSPICIOUS_HOST_PARTS.some((part) => host.includes(part));
};

const inspectLinkRisk = (text) => {
  const urls = extractUrls(text);
  const evidence = [];
  urls.forEach((url) => {
    const host = getHostFromUrl(url);
    if (!host) return;
    if (!looksSuspiciousHost(host)) return;
    evidence.push({
      rule: 'malicious_link',
      type: 'link',
      description: `Suspicious link host: ${host}`,
      snippet: url.slice(0, 160),
    });
  });
  return evidence;
};

const inspectAdsRisk = (text) => {
  const safeText = sanitizeText(text, 5000).toLowerCase();
  if (!safeText) return [];
  const matched = ADS_KEYWORDS.filter((keyword) => safeText.includes(keyword.toLowerCase())).slice(0, 6);
  if (!matched.length) return [];
  return [
    {
      rule: 'ads_spam',
      type: 'keyword',
      description: `Ad/Spam keywords: ${matched.join(', ')}`,
      snippet: safeText.slice(0, 160),
      hits: matched,
    },
  ];
};

const inspectTextRules = (text) => {
  const linkEvidence = inspectLinkRisk(text);
  const adsEvidence = inspectAdsRisk(text);
  const evidence = [...linkEvidence, ...adsEvidence];
  const tags = Array.from(
    new Set(
      evidence
        .map((item) => String(item?.rule || '').trim())
        .filter(Boolean)
    )
  );
  return { evidence, tags };
};

const riskLevelFromScore = (score) => {
  const safeScore = Number.isFinite(Number(score)) ? Number(score) : 0;
  if (safeScore >= 80) return 'high';
  if (safeScore >= 45) return 'medium';
  return 'low';
};

export { inspectTextRules, riskLevelFromScore, sanitizeText };

