/**
 * Guards.gs — the quality firewall.
 *
 * ONE shared rule-set runs in two places:
 *   1. Pool screening (PoolRefill.gs) so junk never enters the board.
 *   2. Every send (Code.gs) — initial AND every follow-up.
 *
 * screenReason_(cand) returns a string reason to REJECT, or '' to allow.
 * `cand` is a plain object: { name, email, notes, topApp, topAppCategory }.
 *
 * UTILITY ADAPTATION: this pipeline targets utility apps, so keywords that the
 * games pipeline treated as "not a game" — wallpaper, vpn, cleaner, ringtone,
 * photo frame — are TARGETS here and are NOT rejected. Everything protective
 * (China policy, farms, brand impersonation, casino/money/vape sanity,
 * disposable + junk emails) is retained unchanged.
 */

// ---------------------------------------------------------------------------
// China policy — explicit business decision to exclude Chinese studios.
// ---------------------------------------------------------------------------
const CHINA_EMAIL_DOMAINS = ['qq.com', '163.com', '126.com', 'foxmail.com'];

const CHINA_CITY_TOKENS = [
  'shenzhen', 'shzhen', 'fuzhou', 'guangzhou', 'hangzhou',
  'beijing', 'shanghai', 'chengdu', 'wuhan'
];

// Standing pinyin block list (named devs recorded as permanent policy).
// Extend this list as the daily human review surfaces new catches.
const CHINA_NAME_BLOCKLIST = [
  'xiuhuigame', 'wuyungame', 'longhuagame', 'chengmai game', 'yoooo game',
  '7377game', 'truthful game', 'creation light', "mu chen's world", 'joyvix',
  'pi game', 'happymate', 'qian yue', 'dream spark', 'nebulagame', 'blacktile',
  'wdbgame', 'maft', 'tong feng qing', 'lbhd', 'leqi game', 'aier tech',
  'funpuzzle'
];

// ---------------------------------------------------------------------------
// Non-developer business names — entities that are clearly not app studios.
// UTILITY NOTE: wallpaper / vpn / cleaner / ringtone / photo frame are removed
// from this list because they are legitimate utility-app themes.
// ---------------------------------------------------------------------------
const NON_APP_NAME_KEYWORDS = [
  'pharma', 'advisory', 'institute', 'instituto', 'facility', 'consulting',
  'finance', 'financial', 'bank', 'insurance', 'hair', 'salon', 'clinic',
  'dental', 'legal', 'law firm', 'real estate', 'logistics',
  'investment', 'joint stock'
];

// Big brands that, on a generic mailbox, signal impersonation.
const BRAND_NAMES = [
  'netease', 'tencent', 'mihoyo', 'lilith', 'funplus', 'supercell',
  'king', 'zynga', 'gameloft', 'ubisoft', 'ea mobile', 'google', 'microsoft',
  'samsung', 'adobe', 'meta'
];
const GENERIC_MAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];

// Disposable / throwaway email domains.
const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com'
];

// Top-app sanity — reject apps that PlayGround will never publish.
// Retained in full from the reference system; utility categories are unaffected.
const TOPAPP_BAD_PATTERNS = [
  /\bvap(e|ing)\b/i, /\bsmoking\b/i, /\bcigarette\b/i, /\bhookah\b/i, /\bshisha\b/i,
  /\bcasino\b/i, /\bslots?\b/i, /\bpoker\b/i, /\broulette\b/i, /\bblackjack\b/i,
  /\baviator\b/i, /\bteen\s?patti\b/i, /\b3\s?patti\b/i, /\brummy\b/i,
  /\blucky\s?spin\b/i, /\bspin\s?&?\s?win\b/i,
  /\bfree\s?diamonds\b/i, /\bff\s?diamonds\b/i,
  /\bearn\s?(money|cash)\b/i, /\bmoney\s?game\b/i, /\bonline\s?cash\b/i,
  /\brewards?\s?cash\b/i, /\bbingo\b/i,
  /\bpaytm\b/i, /\bjazzcash\b/i, /\beasypaisa\b/i, /\bupi\b/i, /\bcashback\b/i,
  /\breal\s?money\b/i, /\bwin\s?cash\b/i, /\bcash$/i
];
const BAD_TOPAPP_CATEGORIES = ['GAME_CASINO'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hasCJK_(s) {
  return /[㐀-鿿぀-ヿ가-힯]/.test(s || '');
}
function emailDomain_(email) {
  const m = String(email || '').toLowerCase().match(/@([^>\s]+)/);
  return m ? m[1] : '';
}
function wordIncludes_(haystack, needle) {
  // word-boundary, case-insensitive
  const re = new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return re.test(haystack || '');
}

// ---------------------------------------------------------------------------
// Main screen. Returns '' to allow, or a short machine-friendly reject reason.
// ---------------------------------------------------------------------------
function screenReason_(cand) {
  const name  = String(cand.name || '');
  const email = String(cand.email || '').toLowerCase();
  const notes = String(cand.notes || '').toLowerCase();
  const nameLc = name.toLowerCase();
  const domain = emailDomain_(email);
  const local  = email.split('@')[0] || '';

  // 1. CHINA POLICY -----------------------------------------------------------
  if (CHINA_EMAIL_DOMAINS.indexOf(domain) !== -1) return 'china_policy:domain';
  if (/\.cn$/.test(domain) || /\.com\.cn$/.test(domain)) return 'china_policy:cn_domain';
  if (hasCJK_(name)) return 'china_policy:cjk_name';
  for (const t of CHINA_CITY_TOKENS) {
    if (nameLc.indexOf(t) !== -1 || email.indexOf(t) !== -1) return 'china_policy:city';
  }
  for (const b of CHINA_NAME_BLOCKLIST) {
    if (nameLc.indexOf(b) !== -1) return 'china_policy:blocklist';
  }

  // 2. FLAGGED NOTES ----------------------------------------------------------
  for (const flag of ['suspicious', 'low confidence', 'removed', 'invalid', 'fake']) {
    if (notes.indexOf(flag) !== -1) return 'flagged_notes';
  }

  // 3. JUNK EMAIL -------------------------------------------------------------
  if (DISPOSABLE_DOMAINS.indexOf(domain) !== -1) return 'suspicious_email:disposable';
  if (/^www\./.test(email)) return 'suspicious_email:www_prefix';
  if (/(asdf|fdsa|qwer|zxcv|jkl|hjkl){1,}/i.test(local)) return 'suspicious_email:keyboard_walk';
  if (/\d{7,}/.test(local)) return 'suspicious_email:long_digits'; // 7+ digits (year suffixes OK)

  // 4. NON-DEVELOPER BUSINESS NAME -------------------------------------------
  for (const kw of NON_APP_NAME_KEYWORDS) {
    if (wordIncludes_(name, kw)) return 'non_app_name:' + kw;
  }

  // 5. BRAND IMPERSONATION ----------------------------------------------------
  if (GENERIC_MAIL_DOMAINS.indexOf(domain) !== -1) {
    for (const brand of BRAND_NAMES) {
      if (wordIncludes_(name, brand)) return 'brand_impersonation';
    }
  }

  // 6. TOP-APP SANITY ---------------------------------------------------------
  const topApp = String(cand.topApp || '');
  const topCat = String(cand.topAppCategory || '');
  if (topApp) {
    if (hasCJK_(topApp)) return 'top_app_sanity:cjk_title'; // never templated
    if (BAD_TOPAPP_CATEGORIES.indexOf(topCat) !== -1) return 'top_app_sanity:category';
    for (const re of TOPAPP_BAD_PATTERNS) {
      if (re.test(topApp)) return 'top_app_sanity:pattern';
    }
  }

  return '';
}

/**
 * Shared-email farm detection. Given the full board index (map of
 * email -> Set of distinct studio names), an email serving 2+ names is a farm.
 * Call from screening with a prebuilt index.
 */
function isSharedEmailFarm_(email, emailToNames) {
  const names = emailToNames[String(email || '').toLowerCase()];
  return !!(names && names.size >= 2);
}
