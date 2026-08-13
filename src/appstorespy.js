'use strict';

const config = require('./config');
const db = require('./db');
const { todayStamp, sleep } = require('./time');
const people = require('./people');

const A = config.appStoreSpy;

function headers() {
  return { 'API-KEY': A.key, 'Content-Type': 'application/json' };
}

/** Daily call cap (persisted in settings, per day). */
async function underCallCap() {
  const key = 'ass_calls_' + todayStamp();
  const n = Number(await db.getSetting(key, '0'));
  return n < A.dailyCallCap;
}
async function countCall() {
  const key = 'ass_calls_' + todayStamp();
  const n = Number(await db.getSetting(key, '0'));
  await db.setSetting(key, n + 1);
}

async function fetchWithBackoff(url, options) {
  let attempt = 0;
  let lastErr;
  while (attempt < 5) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(A.backoffBaseMs * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw lastErr;
}

/**
 * POST /play/apps/query — ACQUISITION funnel: proven-demand utility apps in the
 * all-time installs "sweet spot" with a healthy rating (weak monetization is
 * scored later per candidate). `crit` supplies installsTotalMin/Max, minRating,
 * minRatingCount. Returns an array of app rows.
 */
// Fields the API has told us it doesn't accept for this endpoint. AppStoreSpy
// replies 400 {"errors":[{"location":"fields","message":"Unknown fields",
// "value":[...]}]}, so we remember and stop asking rather than failing forever.
const rejectedFields = new Set();

async function queryApps(category, page, limit, crit) {
  await countCall();
  const c = crit || {};
  const filter = {
    published: true,
    category_type: 'APP',
    category,
    downloads_exact: {
      gte: c.installsTotalMin || 10000,
      lte: c.installsTotalMax || 500000
    }
  };
  if (c.minRating && c.minRating > 0) filter.rating_avg = { gte: c.minRating, lte: 5 };
  if (c.minRatingCount && c.minRatingCount > 0) filter.rating_count = { gte: c.minRatingCount };

  const wanted = ['id', 'bundle', 'name', 'category', 'category_type',
    'downloads_daily', 'downloads_exact', 'downloads_mark', 'revenue_month',
    'rating_avg', 'rating_count', 'iap', 'ads', 'advertised', 'update_date',
    'developer_name', 'developer_id', 'url_appstorespy',
    'website',          // studio's own site — also the "solo dev" signal in the score
    'privacy_policy'];  // fallback source for the studio domain when website is blank

  async function attempt(fields) {
    const body = {
      limit: limit || 100,
      page: page || 1,
      sort: '-downloads_daily', // ongoing install velocity = proven, still-alive demand
      country: 'US',
      fields,
      filter
    };
    const res = await fetchWithBackoff(A.apiUrl + A.endpoint, {
      method: 'POST', headers: headers(), body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  let fields = wanted.filter((f) => !rejectedFields.has(f));
  let { res, json } = await attempt(fields);

  // If the only problem is an unsupported optional field, drop it and retry once
  // so a single unknown field can never break the whole sourcing run.
  if (!res.ok && res.status === 400) {
    const unknown = (json.errors || [])
      .filter((e) => e && e.location === 'fields')
      .flatMap((e) => Array.isArray(e.value) ? e.value : []);
    const droppable = unknown.filter((f) => fields.includes(f));
    if (droppable.length) {
      droppable.forEach((f) => rejectedFields.add(f));
      console.log('[appstorespy] API rejected field(s): ' + droppable.join(', ') + ' — retrying without them');
      fields = fields.filter((f) => !rejectedFields.has(f));
      ({ res, json } = await attempt(fields));
    }
  }

  if (!res.ok) throw new Error('queryApps HTTP ' + res.status + ' ' + JSON.stringify(json).slice(0, 200));
  return json.data || [];
}

// Review-mining: acquisition-signal phrases (willingness to pay / poor monetization).
const REVIEW_SIGNALS = [
  /too expensive/i, /so expensive/i, /overpriced/i, /should be free/i,
  /wish (it|this) (was|were) free/i, /would pay if/i, /i would pay/i, /i'?d pay/i,
  /not worth (the|it|paying|the money)/i, /too many ads/i, /so many ads/i, /remove ads/i,
  /waste of money/i, /rip\s?off/i, /cancel(l?ed)? (my )?subscription/i,
  /expensive subscription/i, /make it free/i, /free version/i, /pay\s?wall/i, /way too much/i
];

/** GET /play/apps/{bundle}/reviews → array of review text strings. */
async function fetchReviews(bundle) {
  await countCall();
  const url = A.apiUrl + '/play/apps/' + encodeURIComponent(bundle) +
    '/reviews?country=US&language=en&limit=50&sort=stars';
  const res = await fetchWithBackoff(url, { method: 'GET', headers: headers() });
  const json = await res.json().catch(() => []);
  const arr = Array.isArray(json) ? json : (json.data || json.reviews || []);
  return arr.map((r) => `${r.title || ''} ${r.text || r.body || r.review || r.content || r.comment || ''}`.trim()).filter(Boolean);
}

/** Count acquisition-signal reviews; return { count, samples[] }. */
function scanReviewSignals(texts) {
  const samples = [];
  let count = 0;
  for (const t of texts || []) {
    for (const re of REVIEW_SIGNALS) {
      if (re.test(t)) { count++; if (samples.length < 3) samples.push(t.slice(0, 160)); break; }
    }
  }
  return { count, samples };
}

/** GET /play/developers/{id} → PlayDev (email[], total_apps, ipd, revenue, ...). */
async function getDeveloper(devId) {
  await countCall();
  const res = await fetchWithBackoff(A.apiUrl + '/play/developers/' + encodeURIComponent(devId), {
    method: 'GET', headers: headers()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('getDeveloper HTTP ' + res.status);
  return json || {};
}

function mapAppRow(row) {
  const bundle = row.bundle || row.id || '';
  const dd = Number(row.downloads_daily || 0);
  return {
    devId: String(row.developer_id || ''),
    devName: String(row.developer_name || ''),
    appName: String(row.name || ''),
    appBundle: bundle,
    appCategory: String(row.category || ''),
    appInstallsDaily: dd,
    appInstallsMonth: dd * 30,
    installsTotal: Number(row.downloads_exact || row.downloads_mark || 0),
    revenueMonth: Number(row.revenue_month || 0),
    ratingAvg: Number(row.rating_avg || 0),
    ratingCount: Number(row.rating_count || 0),
    hasIap: !!row.iap,
    hasAds: !!(row.ads || row.advertised),
    website: String(row.website || ''),
    privacyPolicy: String(row.privacy_policy || ''),
    lastUpdate: String(row.update_date || ''),
    storeLink: bundle
      ? 'https://play.google.com/store/apps/details?id=' + bundle
      : String(row.url_appstorespy || '')
  };
}

const GENERIC_MAIL = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'protonmail.com'];

/** "https://foo.com/privacy/policy" -> "https://foo.com" (the studio's own site). */
function hostAsSite(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    // Policy generators host everyone's policy — their domain is not the studio's.
    if (/(google|firebase|freeprivacypolicy|privacypolicies|termsfeed|iubenda|app-privacy-policy|sites\.google|blogspot|wordpress\.com|github\.io|notion\.so|termly)\./i.test(u.hostname)) return '';
    return u.origin;
  } catch (e) { return ''; }
}

/** "jane@coolapps.io" -> "https://coolapps.io"; generic mailboxes give nothing. */
function siteFromEmail(email) {
  const domain = String(email || '').split('@')[1] || '';
  if (!domain || GENERIC_MAIL.includes(domain.toLowerCase())) return '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(domain)) return '';
  return 'https://' + domain.toLowerCase();
}

/** Acquisition Opportunity Score (0–100): demand × weak-monetization × acquirable. */
function opportunityScore(appRow, dev, email, revPerInstall, website) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const totalApps = Number(dev.total_apps || 0);
  let s = 0;

  // Demand proven (max 40)
  if (appRow.ratingAvg >= 4.3) s += 15; else if (appRow.ratingAvg >= 4.0) s += 8;
  s += Math.min(15, Math.round(Math.log10((appRow.ratingCount || 0) + 1) * 5));
  if (appRow.installsTotal >= 10000 && appRow.installsTotal <= 500000) s += 10;

  // Weak monetization = upside (max 35)
  if (appRow.revenueMonth === 0) s += 20;
  else if (revPerInstall < 0.02) s += 15;
  else if (revPerInstall < 0.05) s += 8;
  if (!appRow.hasIap) s += 8;
  if (!appRow.hasAds) s += 7;

  // Cheap / acquirable (max 25)
  if (GENERIC_MAIL.includes(domain)) s += 10;   // solo/indie signal
  if (!website) s += 8;
  if (totalApps > 0 && totalApps <= 10) s += 4;
  if (appRow.lastUpdate) {
    const ageDays = (Date.now() - new Date(appRow.lastUpdate + 'T00:00:00Z').getTime()) / 86400000;
    if (ageDays > 365) s += 3; // not recently heavily updated → likely cheaper
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

function buildCandidate(appRow, dev) {
  const emails = dev.email || dev.emails || [];
  const email = (emails && emails.length) ? String(emails[0]).toLowerCase() : '';
  const totalApps = Number(dev.total_apps || 0);
  const ipd = Number(dev.ipd || 0);
  const revPerInstall = appRow.appInstallsMonth > 0 ? (appRow.revenueMonth / appRow.appInstallsMonth) : 0;
  // Website comes from the app record (PlayDev has no website field at all).
  // When Play lists none, the privacy-policy host and then the email domain are
  // both good stand-ins for the studio's own site - and a domain is what the
  // site-enrichment step needs to have anything to read at all.
  const listedSite = String(appRow.website || dev.website || '');
  const website = listedSite || hostAsSite(appRow.privacyPolicy) || siteFromEmail(email);
  const person = people.nameFromEmail(email);
  // AppStoreSpy sometimes returns no developer name at all — never leave the
  // Studio column blank; fall back to the app name, then the developer ID.
  const devName = appRow.devName || String(dev.name || '') ||
    (appRow.appName ? appRow.appName + ' (studio unknown)' : '') ||
    (appRow.devId ? 'Dev #' + appRow.devId : 'Unknown studio');
  return {
    devName,
    devId: appRow.devId,
    email,
    // Developer-level installs so daily & monthly are consistent (monthly = 30×daily).
    installsPerDay: ipd,
    installsPerMonth: ipd * 30,
    installsTotal: appRow.installsTotal || 0,
    appsCount: totalApps,
    revenuePerMonth: appRow.revenueMonth || 0,
    revPerInstall: Math.round(revPerInstall * 10000) / 10000,
    ratingAvg: appRow.ratingAvg || 0,
    ratingCount: appRow.ratingCount || 0,
    hasIap: appRow.hasIap,
    hasAds: appRow.hasAds,
    website: website,
    contactName: person.name,
    contactNameSource: person.name ? 'email' : '',
    contactNameConfidence: person.confidence || '',
    linkedin: '',
    // PlayDev.hq_country — free, the developer call is already made, and it is
    // what makes a LinkedIn name search actually narrow down.
    country: people.countryName(dev.hq_country || dev.country || ''),
    lastUpdate: appRow.lastUpdate || '',
    // Scored on the *listed* site only: "Play lists no website" is the solo-dev
    // signal, and a domain we inferred ourselves is not evidence of one.
    opportunity: opportunityScore(appRow, dev, email, revPerInstall, listedSite),
    storeLink: appRow.storeLink || website || String(dev.url || ''),
    priority: ipd * totalApps,
    topApp: appRow.appName || '',
    topAppCategory: appRow.appCategory || ''
  };
}

module.exports = { queryApps, getDeveloper, mapAppRow, buildCandidate, fetchReviews, scanReviewSignals, underCallCap, headers, hostAsSite, siteFromEmail };
