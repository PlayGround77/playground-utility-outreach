'use strict';

/**
 * Screening firewall — one shared rule-set used by both sourcing and sending.
 * screenReason(cand) returns '' to allow or a short reject reason.
 * cand: { name, email, notes, topApp, topAppCategory }
 *
 * UTILITY ADAPTATION: wallpaper / vpn / cleaner / ringtone / photo frame are
 * TARGETS here and are NOT rejected. All protective rules are retained.
 */

const CHINA_EMAIL_DOMAINS = ['qq.com', '163.com', '126.com', 'foxmail.com'];
const CHINA_CITY_TOKENS = ['shenzhen', 'shzhen', 'fuzhou', 'guangzhou', 'hangzhou', 'beijing', 'shanghai', 'chengdu', 'wuhan'];
const CHINA_NAME_BLOCKLIST = [
  'xiuhuigame', 'wuyungame', 'longhuagame', 'chengmai game', 'yoooo game',
  '7377game', 'truthful game', 'creation light', "mu chen's world", 'joyvix',
  'pi game', 'happymate', 'qian yue', 'dream spark', 'nebulagame', 'blacktile',
  'wdbgame', 'maft', 'tong feng qing', 'lbhd', 'leqi game', 'aier tech', 'funpuzzle'
];

// Real-world businesses that are not app studios. (Utility keywords excluded.)
const NON_APP_NAME_KEYWORDS = [
  'pharma', 'advisory', 'institute', 'instituto', 'facility', 'consulting',
  'finance', 'financial', 'bank', 'insurance', 'hair', 'salon', 'clinic',
  'dental', 'legal', 'law firm', 'real estate', 'logistics', 'investment', 'joint stock'
];

const BRAND_NAMES = [
  'netease', 'tencent', 'mihoyo', 'lilith', 'funplus', 'supercell', 'king',
  'zynga', 'gameloft', 'ubisoft', 'ea mobile', 'google', 'microsoft', 'samsung', 'adobe', 'meta'
];
const GENERIC_MAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];

// Official companies / governments — they will never hand over their apps.
const OFFICIAL_EMAIL_DOMAINS = [
  'apple.com', 'google.com', 'gmail.google.com', 'samsung.com', 'microsoft.com',
  'amazon.com', 'meta.com', 'facebook.com', 'adobe.com', 'huawei.com', 'xiaomi.com',
  'oppo.com', 'vivo.com', 'sony.com', 'lg.com', 'lge.com', 'intel.com', 'oracle.com',
  'ibm.com', 'nvidia.com', 'yandex.com', 'yandex.ru', 'mozilla.org', 'opera.com',
  'spotify.com', 'netflix.com', 'paypal.com', 'uber.com', 'airbnb.com'
];
const OFFICIAL_NAME_KEYWORDS = [
  'national informatics', 'informatics centre', 'informatics center', 'ministry',
  'municipal', 'e-governance', 'national portal', 'government of', 'govt of'
];
const BIG_BRAND_NAMES = [
  'apple', 'google', 'samsung', 'microsoft', 'huawei', 'xiaomi', 'oppo', 'vivo',
  'sony', 'lg electronics', 'intel', 'oracle', 'ibm', 'nvidia', 'amazon',
  'meta platforms', 'adobe', 'yandex', 'mozilla', 'spotify', 'netflix', 'paypal', 'uber'
];
function isGovDomain(d) {
  return /(^|\.)gov(\.[a-z]{2,3})*$/.test(d) || /\.go\.[a-z]{2}$/.test(d) ||
    /\.gob\.[a-z]{2}$/.test(d) || /\.gouv\.[a-z]{2}$/.test(d) || /\.mil$/.test(d);
}

// Competitor publishers — their studios won't sell/hand over apps to us.
// Matched by exact (case-insensitive) developer/account name.
const COMPETITOR_ACCOUNTS = new Set([
  'altrum', 'battery stats saver', 'beat blend labs', 'bizcraft apps',
  'dictionaryandtranslator', 'dosa apps', 'dzine media', 'dzine media apps',
  'eagle apps', 'eco mobile', 'eco mobile connect', 'eco mobile editor',
  'eco mobile for work', 'eco mobile security', 'eco mobile style', 'eco mobile tools',
  'jrt studio music players', 'lime spark apps', 'manuelitagg', 'mobile tools pro',
  'omega centauri software', 'one music player',
  'photo & video editors - instant solution', 'pipi chick studio',
  'prometheus interactive llc', 'smart mobile tools', 'tarrysoft', 'trostun apps',
  'wallet passes alliance', 'zipoapps', 'zipoby'
]);

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com'
];

const TOPAPP_BAD_PATTERNS = [
  /\bvap(e|ing)\b/i, /\bsmoking\b/i, /\bcigarette\b/i, /\bhookah\b/i, /\bshisha\b/i,
  /\bcasino\b/i, /\bslots?\b/i, /\bpoker\b/i, /\broulette\b/i, /\bblackjack\b/i,
  /\baviator\b/i, /\bteen\s?patti\b/i, /\b3\s?patti\b/i, /\brummy\b/i,
  /\blucky\s?spin\b/i, /\bspin\s?&?\s?win\b/i, /\bfree\s?diamonds\b/i, /\bff\s?diamonds\b/i,
  /\bearn\s?(money|cash)\b/i, /\bmoney\s?game\b/i, /\bonline\s?cash\b/i,
  /\brewards?\s?cash\b/i, /\bbingo\b/i, /\bpaytm\b/i, /\bjazzcash\b/i, /\beasypaisa\b/i,
  /\bupi\b/i, /\bcashback\b/i, /\breal\s?money\b/i, /\bwin\s?cash\b/i, /\bcash$/i
];
const BAD_TOPAPP_CATEGORIES = ['GAME_CASINO'];

function hasCJK(s) { return /[㐀-鿿぀-ヿ가-힯]/.test(s || ''); }
function emailDomain(email) {
  const m = String(email || '').toLowerCase().match(/@([^>\s]+)/);
  return m ? m[1] : '';
}
function wordIncludes(haystack, needle) {
  const re = new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return re.test(haystack || '');
}

function screenReason(cand) {
  const name = String(cand.name || '');
  const email = String(cand.email || '').toLowerCase();
  const notes = String(cand.notes || '').toLowerCase();
  const nameLc = name.toLowerCase();
  const domain = emailDomain(email);
  const local = email.split('@')[0] || '';

  // 1. China policy
  if (CHINA_EMAIL_DOMAINS.includes(domain)) return 'china_policy:domain';
  if (/\.cn$/.test(domain) || /\.com\.cn$/.test(domain)) return 'china_policy:cn_domain';
  if (hasCJK(name)) return 'china_policy:cjk_name';
  for (const t of CHINA_CITY_TOKENS) if (nameLc.includes(t) || email.includes(t)) return 'china_policy:city';
  for (const b of CHINA_NAME_BLOCKLIST) if (nameLc.includes(b)) return 'china_policy:blocklist';

  // 2. Flagged notes
  for (const flag of ['suspicious', 'low confidence', 'removed', 'invalid', 'fake']) {
    if (notes.includes(flag)) return 'flagged_notes';
  }

  // 3. Junk email
  if (DISPOSABLE_DOMAINS.includes(domain)) return 'suspicious_email:disposable';
  if (/^www\./.test(email)) return 'suspicious_email:www_prefix';
  if (/(asdf|fdsa|qwer|zxcv|jkl|hjkl)/i.test(local)) return 'suspicious_email:keyboard_walk';
  if (/\d{7,}/.test(local)) return 'suspicious_email:long_digits';

  // 4. Non-developer business names
  for (const kw of NON_APP_NAME_KEYWORDS) if (wordIncludes(name, kw)) return 'non_app_name:' + kw;

  // 5. Brand impersonation
  if (GENERIC_MAIL_DOMAINS.includes(domain)) {
    for (const brand of BRAND_NAMES) if (wordIncludes(name, brand)) return 'brand_impersonation';
  }

  // 5b. Official companies & governments (won't sell / hand over their apps)
  if (OFFICIAL_EMAIL_DOMAINS.includes(domain)) return 'official_company:domain';
  if (isGovDomain(domain)) return 'government:domain';
  for (const kw of OFFICIAL_NAME_KEYWORDS) if (nameLc.includes(kw)) return 'official_name';
  for (const b of BIG_BRAND_NAMES) if (wordIncludes(name, b)) return 'official_brand';

  // 5c. Competitor publishers (their studios won't sell to us)
  if (COMPETITOR_ACCOUNTS.has(nameLc.trim())) return 'competitor';

  // 6. Top-app sanity
  const topApp = String(cand.topApp || '');
  const topCat = String(cand.topAppCategory || '');
  if (topApp) {
    if (hasCJK(topApp)) return 'top_app_sanity:cjk_title';
    if (BAD_TOPAPP_CATEGORIES.includes(topCat)) return 'top_app_sanity:category';
    for (const re of TOPAPP_BAD_PATTERNS) if (re.test(topApp)) return 'top_app_sanity:pattern';
  }

  return '';
}

module.exports = { screenReason, hasCJK };
