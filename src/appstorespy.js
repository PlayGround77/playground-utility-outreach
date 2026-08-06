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
 * POST /play/apps/query — utility apps (not games) in the installs band.
 * downloads_month is unreliable, so the band is applied to downloads_daily
 * (monthly band / 30). Returns an array of app rows.
 */
async function queryApps(category, page, limit, band) {
  await countCall();
  const b = band || A.installsBand;
  const dailyMin = Math.max(1, Math.round(b.minPerMonth / 30));
  const dailyMax = Math.round(b.maxPerMonth / 30);
  const body = {
    limit: limit || 100,
    page: page || 1,
    sort: '-downloads_daily',
    country: 'US',
    fields: ['id', 'bundle', 'name', 'category', 'category_type',
      'downloads_daily', 'downloads_exact', 'downloads_mark', 'revenue_month',
      'developer_name', 'developer_id', 'url_appstorespy'],
    filter: {
      published: true,
      category_type: 'APP',
      category,
      downloads_daily: { gte: dailyMin, lte: dailyMax }
    }
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
    revenueMonth: Number(row.revenue_month || 0),
    storeLink: bundle
      ? 'https://play.google.com/store/apps/details?id=' + bundle
      : String(row.url_appstorespy || '')
  };
}

function buildCandidate(appRow, dev) {
  const emails = dev.email || dev.emails || [];
  const email = (emails && emails.length) ? String(emails[0]).toLowerCase() : '';
  const totalApps = Number(dev.total_apps || 0);
  const ipd = Number(dev.ipd || 0);
  return {
    devName: appRow.devName || String(dev.name || ''),
    devId: appRow.devId,
    email,
    installsPerMonth: appRow.appInstallsMonth || ipd * 30,
    installsPerDay: ipd,
    appsCount: totalApps,
    revenuePerMonth: appRow.revenueMonth || 0,
    storeLink: appRow.storeLink || String(dev.url || ''),
    priority: ipd * totalApps,
    topApp: appRow.appName || '',
    topAppCategory: appRow.appCategory || ''
  };
}

module.exports = { queryApps, getDeveloper, mapAppRow, buildCandidate, underCallCap, headers };
