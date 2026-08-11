'use strict';

const config = require('./config');
const db = require('./db');
const { todayStamp, sleep } = require('./time');

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
  const body = {
    limit: limit || 100,
    page: page || 1,
    sort: '-downloads_daily', // ongoing install velocity = proven, still-alive demand
    country: 'US',
    fields: ['id', 'bundle', 'name', 'category', 'category_type',
      'downloads_daily', 'downloads_exact', 'downloads_mark', 'revenue_month',
      'rating_avg', 'rating_count', 'iap', 'ads', 'advertised', 'update_date',
      'developer_name', 'developer_id', 'url_appstorespy'],
    filter: filter
  };
  const res = await fetchWithBackoff(A.apiUrl + A.endpoint, {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('queryApps HTTP ' + res.status + ' ' + JSON.stringify(json).slice(0, 200));
  return json.data || [];
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
    appCategory: String(row.category || ''),
    appInstallsDaily: dd,
    appInstallsMonth: dd * 30,
    installsTotal: Number(row.downloads_exact || row.downloads_mark || 0),
    revenueMonth: Number(row.revenue_month || 0),
    ratingAvg: Number(row.rating_avg || 0),
    ratingCount: Number(row.rating_count || 0),
    hasIap: !!row.iap,
    hasAds: !!(row.ads || row.advertised),
    lastUpdate: String(row.update_date || ''),
    storeLink: bundle
      ? 'https://play.google.com/store/apps/details?id=' + bundle
      : String(row.url_appstorespy || '')
  };
}

const GENERIC_MAIL = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'protonmail.com'];

/** Acquisition Opportunity Score (0–100): demand × weak-monetization × acquirable. */
function opportunityScore(appRow, dev, email, revPerInstall) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const website = String(dev.website || '');
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
  const website = String(dev.website || '');
  return {
    devName: appRow.devName || String(dev.name || ''),
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
    lastUpdate: appRow.lastUpdate || '',
    opportunity: opportunityScore(appRow, dev, email, revPerInstall),
    storeLink: appRow.storeLink || website || String(dev.url || ''),
    priority: ipd * totalApps,
    topApp: appRow.appName || '',
    topAppCategory: appRow.appCategory || ''
  };
}

module.exports = { queryApps, getDeveloper, mapAppRow, buildCandidate, underCallCap, headers };
