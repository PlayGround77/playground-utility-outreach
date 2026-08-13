'use strict';

/**
 * Optional LinkedIn lookup via Apify.
 *
 * Deliberately NOT a LinkedIn scraper. We run Apify's Google Search Scraper
 * against `site:linkedin.com/in "<name>" "<studio>"` and read the profile URLs
 * out of the organic results. Google has already indexed those public profiles,
 * which makes this cheaper per lookup, far more stable (LinkedIn actively
 * blocks scrapers), and it never sends a request to LinkedIn at all.
 *
 * We return *candidates* with the snippet Google showed, not a single "the
 * answer". Picking the right person stays a human judgement - a matcher would
 * confidently pick wrong and we would email a stranger about buying an app they
 * have nothing to do with.
 *
 * Costs money per call, so it is opt-in, capped per day, and meant for
 * shortlisted leads rather than every lead in a refill.
 *
 * NOTE: this module could not be exercised against the live Apify API from the
 * development sandbox (its egress policy blocks api.apify.com), so the request
 * shape follows Apify's documented run-sync-get-dataset-items contract and the
 * response parsing is defensive about field names. Verify once in the deployed
 * environment before trusting a run.
 */

const db = require('./db');
const people = require('./people');
const { todayStamp } = require('./time');

const ACTOR = 'apify~google-search-scraper';
const BASE = 'https://api.apify.com/v2/acts/';
const TIMEOUT_MS = 120000;   // actor runs are not instant
const DAILY_CAP = 200;       // hard backstop on spend

/** Token comes from the environment, or from settings (dashboard-editable). */
async function token() {
  const fromEnv = String(process.env.APIFY_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  return String(await db.getSetting('apify_token', '')).trim();
}

async function enabled() {
  return !!(await token());
}

async function underCap() {
  const key = 'apify_calls_' + todayStamp();
  return Number(await db.getSetting(key, '0')) < DAILY_CAP;
}
async function countCall() {
  const key = 'apify_calls_' + todayStamp();
  const n = Number(await db.getSetting(key, '0'));
  await db.setSetting(key, String(n + 1));
}

/** Run the Google scraper actor synchronously and return its dataset items. */
async function runSearch(queries) {
  const tok = await token();
  if (!tok) throw new Error('APIFY_TOKEN is not set');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      BASE + ACTOR + '/run-sync-get-dataset-items?token=' + encodeURIComponent(tok),
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: queries.join('\n'),
          maxPagesPerQuery: 1,
          resultsPerPage: 10,
          countryCode: 'us',
          languageCode: 'en'
        })
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('apify HTTP ' + res.status + ' ' + body.slice(0, 200));
    }
    const json = await res.json().catch(() => []);
    return Array.isArray(json) ? json : (json.items || []);
  } finally {
    clearTimeout(timer);
  }
}

const PROFILE_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9._%-]+/i;

/** Pull LinkedIn /in/ profile hits out of whatever shape the actor returned. */
function parseResults(items) {
  const out = [];
  for (const item of items || []) {
    const organic = item && (item.organicResults || item.results || []);
    for (const r of organic || []) {
      const url = String((r && (r.url || r.link)) || '');
      if (!PROFILE_RE.test(url)) continue;
      const clean = url.split('?')[0].replace(/\/$/, '');
      if (out.some((o) => o.url === clean)) continue;
      out.push({
        url: clean,
        title: String((r.title || '')).slice(0, 160),
        snippet: String((r.description || r.snippet || '')).slice(0, 300)
      });
    }
  }
  return out;
}

/**
 * Score a candidate against what we know, so the operator sees the likeliest
 * person first. This ranks; it never auto-selects.
 */
function scoreCandidate(cand, { contactName, studio, appName, country }) {
  const hay = (cand.title + ' ' + cand.snippet).toLowerCase();
  let s = 0;
  if (contactName && cand.title.toLowerCase().includes(String(contactName).toLowerCase())) s += 40;
  if (studio && hay.includes(people.cleanStudio(studio).toLowerCase())) s += 30;
  if (appName && hay.includes(String(appName).toLowerCase())) s += 20;
  if (country && hay.includes(String(country).toLowerCase())) s += 10;
  if (/founder|owner|ceo|developer|indie/i.test(hay)) s += 5;
  return s;
}

/**
 * Look up likely LinkedIn profiles for one lead.
 * Returns { candidates: [{url,title,snippet,score}], queries, skipped }.
 * Never throws - a failed lookup is reported, not propagated.
 */
async function findProfiles(lead) {
  const info = {
    contactName: lead.contact_name || lead.contactName || '',
    studio: lead.name || lead.devName || '',
    appName: lead.top_app || lead.topApp || '',
    country: lead.country || ''
  };

  const studio = people.cleanStudio(info.studio);
  const queries = [];
  if (info.contactName) {
    queries.push(`site:linkedin.com/in "${info.contactName}"` + (studio ? ` "${studio}"` : ''));
    if (info.country) queries.push(`site:linkedin.com/in "${info.contactName}" ${info.country}`);
  }
  if (studio) queries.push(`site:linkedin.com/in "${studio}" (founder OR developer)`);
  if (info.appName) queries.push(`site:linkedin.com/in "${info.appName}"`);

  if (!queries.length) return { candidates: [], queries: [], skipped: 'no search signal' };
  if (!(await enabled())) return { candidates: [], queries, skipped: 'no Apify token' };
  if (!(await underCap())) return { candidates: [], queries, skipped: 'daily Apify cap reached' };

  try {
    await countCall();
    const items = await runSearch(queries.slice(0, 3));
    const candidates = parseResults(items)
      .map((c) => ({ ...c, score: scoreCandidate(c, info) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return { candidates, queries, skipped: '' };
  } catch (e) {
    return { candidates: [], queries, skipped: e.message };
  }
}

module.exports = { findProfiles, parseResults, scoreCandidate, runSearch, enabled, DAILY_CAP };
