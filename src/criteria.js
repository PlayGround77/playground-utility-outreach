'use strict';

/**
 * Editable search criteria. Defaults come from env vars (config); overrides are
 * stored in the DB (settings key "criteria") and edited from the dashboard.
 * The sourcing job reads the EFFECTIVE criteria at run time, so changes take
 * effect on the next "Source now" / scheduled refill — no redeploy needed.
 */

const db = require('./db');
const config = require('./config');

const KEY = 'criteria';

// Valid Google Play APP categories (games excluded — we target utility apps).
const VALID_CATEGORIES = [
  'APPLICATION', 'ANDROID_WEAR', 'ART_AND_DESIGN', 'AUTO_AND_VEHICLES', 'BEAUTY',
  'BOOKS_AND_REFERENCE', 'BUSINESS', 'COMICS', 'COMMUNICATION', 'DATING',
  'EDUCATION', 'ENTERTAINMENT', 'EVENTS', 'FINANCE', 'FOOD_AND_DRINK',
  'HEALTH_AND_FITNESS', 'HOUSE_AND_HOME', 'LIBRARIES_AND_DEMO', 'LIFESTYLE',
  'MAPS_AND_NAVIGATION', 'MEDICAL', 'MUSIC_AND_AUDIO', 'NEWS_AND_MAGAZINES',
  'PARENTING', 'PERSONALIZATION', 'PHOTOGRAPHY', 'PRODUCTIVITY', 'SHOPPING',
  'SOCIAL', 'SPORTS', 'TOOLS', 'TRAVEL_AND_LOCAL', 'VIDEO_PLAYERS', 'WEATHER'
];

function defaults() {
  return {
    categories: config.appStoreSpy.categories.filter((c) => VALID_CATEGORIES.includes(c)),
    installsMin: config.appStoreSpy.installsBand.minPerMonth,
    installsMax: config.appStoreSpy.installsBand.maxPerMonth,
    minApps: config.appStoreSpy.minAppsCount,
    // ---- acquisition funnel ----
    installsTotalMin: Number(process.env.INSTALLS_TOTAL_MIN) || 10000,   // all-time installs sweet spot
    installsTotalMax: Number(process.env.INSTALLS_TOTAL_MAX) || 500000,
    minRating: Number(process.env.MIN_RATING) || 4.3,                    // proven quality
    minRatingCount: Number(process.env.MIN_RATING_COUNT) || 50,          // reliable rating
    maxApps: Number(process.env.MAX_APPS_PER_DEV) || 40,                 // avoid giant farms
    scanReviews: process.env.SCAN_REVIEWS === 'false' ? false : true,    // mine reviews for buy-signals (costs credits)
    enrichFromSite: process.env.ENRICH_FROM_SITE === 'true',             // read the studio's own site for a person name + LinkedIn (free, but slow)
    dailyQuotaOverride: Number(process.env.DAILY_QUOTA_OVERRIDE) || 0,   // 0 = use the warm-up ramp; >0 = fixed emails/day
    revenueMax: config.appStoreSpy.revenueMaxPerMonth,
    maxPriority: Number(process.env.MAX_PRIORITY) || 100000000, // flag giants above this (priority = ipd × apps)
    pagesPerCategory: config.appStoreSpy.pagesPerCategory,
    refillTarget: config.safety.refillTarget
  };
}

async function get() {
  const raw = await db.getSetting(KEY, null);
  if (!raw) return defaults();
  try { return { ...defaults(), ...JSON.parse(raw) }; }
  catch (e) { return defaults(); }
}

/** Clean + clamp raw form input into a valid criteria object. */
function sanitize(input, base) {
  const out = { ...(base || defaults()) };

  if (input.categories !== undefined) {
    const list = String(input.categories)
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      .filter((c) => VALID_CATEGORIES.includes(c));
    if (list.length) out.categories = Array.from(new Set(list));
  }
  for (const flag of ['scanReviews', 'enrichFromSite']) {
    if (flag in input) {
      out[flag] = input[flag] === true || input[flag] === 'true' ||
        input[flag] === 'on' || input[flag] === '1';
    }
  }
  for (const f of ['installsMin', 'installsMax', 'minApps', 'installsTotalMin', 'installsTotalMax', 'minRating', 'minRatingCount', 'maxApps', 'revenueMax', 'maxPriority', 'pagesPerCategory', 'refillTarget', 'dailyQuotaOverride']) {
    if (input[f] !== undefined && input[f] !== '') {
      const n = Number(input[f]);
      if (Number.isFinite(n)) out[f] = n;
    }
  }
  out.installsMin = Math.max(0, Math.round(out.installsMin));
  out.installsMax = Math.max(out.installsMin + 1, Math.round(out.installsMax));
  out.minApps = Math.max(1, Math.round(out.minApps));
  out.minRating = Math.min(5, Math.max(0, Number(out.minRating) || 0));
  out.installsTotalMin = Math.max(0, Math.round(out.installsTotalMin));
  out.installsTotalMax = Math.max(out.installsTotalMin + 1, Math.round(out.installsTotalMax));
  out.minRatingCount = Math.max(0, Math.round(out.minRatingCount));
  out.maxApps = Math.max(1, Math.round(out.maxApps));
  out.dailyQuotaOverride = Math.max(0, Math.round(out.dailyQuotaOverride));
  out.revenueMax = Math.max(0, Math.round(out.revenueMax));
  out.maxPriority = Math.max(0, Math.round(out.maxPriority));
  out.pagesPerCategory = Math.min(20, Math.max(1, Math.round(out.pagesPerCategory)));
  out.refillTarget = Math.min(2000, Math.max(1, Math.round(out.refillTarget)));
  return out;
}

async function set(input) {
  const clean = sanitize(input, await get());
  await db.setSetting(KEY, JSON.stringify(clean));
  return clean;
}

module.exports = { get, set, sanitize, defaults, VALID_CATEGORIES };
