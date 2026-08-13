'use strict';

const { Pool } = require('pg');
const config = require('./config');
const { todayStamp } = require('./time');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Railway internal Postgres does not require SSL; managed external does.
  ssl: /railway|sslmode=require/i.test(config.databaseUrl) && !/localhost|127\.0\.0\.1/.test(config.databaseUrl)
    ? { rejectUnauthorized: false } : false
});

async function q(text, params) {
  return pool.query(text, params);
}

/** Create tables if they don't exist. */
async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS leads (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      email         TEXT NOT NULL DEFAULT '',
      outreach      TEXT NOT NULL DEFAULT '',
      response      TEXT NOT NULL DEFAULT '',
      initial_date  DATE,
      fu1_date      DATE,
      fu2_date      DATE,
      priority      BIGINT NOT NULL DEFAULT 0,
      notes         TEXT NOT NULL DEFAULT '',
      store_link    TEXT NOT NULL DEFAULT '',
      top_app       TEXT NOT NULL DEFAULT '',
      apps_json     TEXT NOT NULL DEFAULT '',
      category      TEXT NOT NULL DEFAULT '',
      installs_day  BIGINT NOT NULL DEFAULT 0,
      installs_month BIGINT NOT NULL DEFAULT 0,
      revenue_month BIGINT NOT NULL DEFAULT 0,
      apps_count    INTEGER NOT NULL DEFAULT 0,
      rating_avg    NUMERIC NOT NULL DEFAULT 0,
      rating_count  BIGINT NOT NULL DEFAULT 0,
      installs_total BIGINT NOT NULL DEFAULT 0,
      rev_per_install NUMERIC NOT NULL DEFAULT 0,
      has_iap       BOOLEAN NOT NULL DEFAULT false,
      has_ads       BOOLEAN NOT NULL DEFAULT false,
      website       TEXT NOT NULL DEFAULT '',
      contact_name  TEXT NOT NULL DEFAULT '',
      contact_name_source TEXT NOT NULL DEFAULT '',
      linkedin_url  TEXT NOT NULL DEFAULT '',
      country       TEXT NOT NULL DEFAULT '',
      site_checked_at TEXT NOT NULL DEFAULT '',
      last_update   TEXT NOT NULL DEFAULT '',
      opportunity   INTEGER NOT NULL DEFAULT 0,
      review_signals INTEGER NOT NULL DEFAULT 0,
      review_evidence TEXT NOT NULL DEFAULT '',
      platform      TEXT NOT NULL DEFAULT 'android',
      reply_snippet TEXT NOT NULL DEFAULT '',
      reply_subject TEXT NOT NULL DEFAULT '',
      reply_at      TEXT NOT NULL DEFAULT '',
      reply_thread  TEXT NOT NULL DEFAULT '',
      grp           TEXT NOT NULL DEFAULT '',
      developer_id  TEXT NOT NULL DEFAULT '',
      message_id    TEXT NOT NULL DEFAULT '',
      thread_id     TEXT NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Migrations for an already-created table (safe no-ops if columns exist).
  for (const col of [
    "category TEXT NOT NULL DEFAULT ''",
    'installs_day BIGINT NOT NULL DEFAULT 0',
    'installs_month BIGINT NOT NULL DEFAULT 0',
    'revenue_month BIGINT NOT NULL DEFAULT 0',
    'apps_count INTEGER NOT NULL DEFAULT 0',
    "thread_id TEXT NOT NULL DEFAULT ''",
    "apps_json TEXT NOT NULL DEFAULT ''",
    'rating_avg NUMERIC NOT NULL DEFAULT 0',
    'rating_count BIGINT NOT NULL DEFAULT 0',
    'installs_total BIGINT NOT NULL DEFAULT 0',
    'rev_per_install NUMERIC NOT NULL DEFAULT 0',
    'has_iap BOOLEAN NOT NULL DEFAULT false',
    'has_ads BOOLEAN NOT NULL DEFAULT false',
    "website TEXT NOT NULL DEFAULT ''",
    "contact_name TEXT NOT NULL DEFAULT ''",
    "contact_name_source TEXT NOT NULL DEFAULT ''",
    "linkedin_url TEXT NOT NULL DEFAULT ''",
    "country TEXT NOT NULL DEFAULT ''",
    "site_checked_at TEXT NOT NULL DEFAULT ''",
    "last_update TEXT NOT NULL DEFAULT ''",
    'opportunity INTEGER NOT NULL DEFAULT 0',
    'review_signals INTEGER NOT NULL DEFAULT 0',
    "review_evidence TEXT NOT NULL DEFAULT ''",
    "platform TEXT NOT NULL DEFAULT 'android'",
    "reply_snippet TEXT NOT NULL DEFAULT ''",
    "reply_subject TEXT NOT NULL DEFAULT ''",
    "reply_at TEXT NOT NULL DEFAULT ''",
    "reply_thread TEXT NOT NULL DEFAULT ''"
  ]) {
    await q(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ${col};`);
  }
  await q(`
    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER,
      type        TEXT NOT NULL,
      day         DATE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_leads_outreach ON leads(outreach);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_leads_grp ON leads(grp);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_events_day ON events(day, type);`);
}

/* ------------------------------------------------------------------ leads */

async function allLeads() {
  const r = await q('SELECT * FROM leads ORDER BY opportunity DESC, priority DESC');
  return r.rows;
}

// Insert a lead, but SKIP if a lead with the same email already exists
// (DB-level duplicate prevention, independent of the in-memory dedup index).
// Returns the new id, or null if it was a duplicate.
async function insertLead(lead) {
  const appsJson = JSON.stringify(lead.topApp ? [lead.topApp] : []);
  const r = await q(
    `INSERT INTO leads
       (name,email,priority,top_app,apps_json,store_link,grp,developer_id,
        category,installs_day,installs_month,revenue_month,apps_count,rating_avg,rating_count,
        installs_total,rev_per_install,has_iap,has_ads,website,last_update,opportunity,
        review_signals,review_evidence,platform,
        contact_name,contact_name_source,linkedin_url,country,site_checked_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
     WHERE $2 = '' OR NOT EXISTS (SELECT 1 FROM leads WHERE email <> '' AND lower(email) = lower($2))
     RETURNING id`,
    [lead.name, lead.email, lead.priority || 0, lead.topApp || '', appsJson, lead.storeLink || '',
      lead.grp || '', lead.developerId || '', lead.category || '',
      lead.installsDay || 0, lead.installsMonth || 0, lead.revenueMonth || 0, lead.appsCount || 0,
      lead.ratingAvg || 0, lead.ratingCount || 0,
      lead.installsTotal || 0, lead.revPerInstall || 0, !!lead.hasIap, !!lead.hasAds,
      lead.website || '', lead.lastUpdate || '', lead.opportunity || 0,
      lead.reviewSignals || 0, lead.reviewEvidence || '', lead.platform || 'android',
      lead.contactName || '', lead.contactNameSource || '', lead.linkedin || '',
      lead.country || '', lead.siteCheckedAt || '']
  );
  return r.rows.length ? r.rows[0].id : null;
}

// Append an app name to the app list of the matching lead (by 'dev' or 'email').
// matchCol is code-controlled (never user input). Returns true if a lead matched.
async function appendApp(matchCol, matchVal, appName) {
  const where = matchCol === 'email' ? 'lower(email) = lower($1)' : 'developer_id = $1';
  const r = await q(`SELECT id, apps_json, top_app FROM leads WHERE ${where} ORDER BY id ASC LIMIT 1`, [matchVal]);
  if (!r.rows.length) return false;
  const row = r.rows[0];
  let list = [];
  try { list = JSON.parse(row.apps_json || '[]'); if (!Array.isArray(list)) list = []; } catch (e) { list = []; }
  if (!list.length && row.top_app) list = [row.top_app];
  if (appName && !list.includes(appName)) list.push(appName);
  await q('UPDATE leads SET apps_json = $1, updated_at = now() WHERE id = $2', [JSON.stringify(list), row.id]);
  return true;
}

// Groups of leads sharing an email (only groups with >1 row).
async function duplicateGroups() {
  const r = await q("SELECT * FROM leads WHERE email <> '' ORDER BY lower(email), id");
  const map = new Map();
  for (const row of r.rows) {
    const k = (row.email || '').toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  const groups = [];
  for (const [email, rows] of map) if (rows.length > 1) groups.push({ email, rows });
  return groups;
}

// Merge all leads sharing an email into one: keep the most-advanced row, union
// their app lists, take the max priority, delete the rest.
async function mergeByEmail(email) {
  const r = await q(
    `SELECT * FROM leads WHERE lower(email) = lower($1)
     ORDER BY (outreach <> '') DESC, (message_id <> '') DESC, id ASC`, [email]);
  if (r.rows.length < 2) return { kept: r.rows[0] && r.rows[0].id, removed: 0, appsCount: 0 };
  const primary = r.rows[0];
  const apps = new Set();
  for (const row of r.rows) {
    let list = [];
    try { list = JSON.parse(row.apps_json || '[]'); } catch (e) { list = []; }
    (Array.isArray(list) ? list : []).forEach((a) => { if (a) apps.add(a); });
    if (row.top_app) apps.add(row.top_app);
  }
  const appsArr = Array.from(apps);
  const maxPriority = Math.max.apply(null, r.rows.map((x) => Number(x.priority) || 0));
  await q('UPDATE leads SET apps_json = $1, priority = $2, updated_at = now() WHERE id = $3',
    [JSON.stringify(appsArr), maxPriority, primary.id]);
  const removeIds = r.rows.slice(1).map((x) => x.id);
  await q('DELETE FROM leads WHERE id = ANY($1)', [removeIds]);
  return { kept: primary.id, removed: removeIds.length, appsCount: appsArr.length };
}

// Delete the extra rows of an email group without merging apps (keep primary).
async function deleteExtrasByEmail(email) {
  const r = await q(
    `SELECT id FROM leads WHERE lower(email) = lower($1)
     ORDER BY (outreach <> '') DESC, (message_id <> '') DESC, id ASC`, [email]);
  const removeIds = r.rows.slice(1).map((x) => x.id);
  if (removeIds.length) await q('DELETE FROM leads WHERE id = ANY($1)', [removeIds]);
  return removeIds.length;
}

async function mergeAllDuplicates() {
  const groups = await duplicateGroups();
  let removed = 0;
  for (const g of groups) { const res = await mergeByEmail(g.email); removed += res.removed; }
  return { groups: groups.length, removed };
}

// Count duplicate leads (extra rows sharing an email).
async function countDuplicates() {
  const r = await q(
    `SELECT COALESCE(SUM(cnt - 1), 0)::int AS n FROM
       (SELECT count(*) cnt FROM leads WHERE email <> '' GROUP BY lower(email) HAVING count(*) > 1) x`
  );
  return r.rows[0].n;
}

// Remove duplicate leads by email, keeping the most-advanced row per email
// (prefers one already contacted / with a thread, else the earliest). Returns removed count.
async function removeDuplicates() {
  const r = await q(
    `WITH ranked AS (
       SELECT id, row_number() OVER (
         PARTITION BY lower(email)
         ORDER BY (outreach <> '') DESC, (message_id <> '') DESC, id ASC
       ) rn
       FROM leads WHERE email <> ''
     )
     DELETE FROM leads WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`
  );
  return r.rowCount || 0;
}

async function updateLead(id, fields) {
  const cols = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = $${i++}`);
    vals.push(v);
  }
  cols.push(`updated_at = now()`);
  vals.push(id);
  await q(`UPDATE leads SET ${cols.join(', ')} WHERE id = $${i}`, vals);
}

/** Whole-DB dedup index (name|email and email:) — includes Block List & Replied. */
async function dedupIndex() {
  const r = await q('SELECT name, email FROM leads');
  const idx = new Set();
  for (const row of r.rows) {
    idx.add((row.name || '').trim().toLowerCase() + '|' + (row.email || '').trim().toLowerCase());
    if (row.email) idx.add('email:' + row.email.trim().toLowerCase());
  }
  return idx;
}

async function clearLeads() {
  await q('DELETE FROM leads');
  await q('DELETE FROM events');
}

// Backfill blank studio names on already-imported leads (older sourcing runs
// before the devName fallback existed). Returns the number of rows fixed.
async function backfillBlankNames() {
  const r = await q(
    `UPDATE leads SET name = COALESCE(
       NULLIF(top_app, '') || ' (studio unknown)',
       'Dev #' || NULLIF(developer_id, ''),
       'Unknown studio'
     ), updated_at = now()
     WHERE trim(name) = ''`
  );
  return r.rowCount || 0;
}

/**
 * Leads whose studio site is worth (re)reading: we have a site, we are still
 * missing a verified name or LinkedIn, and we have not checked recently.
 * Ordered by opportunity so a capped run spends its budget on the best leads.
 */
async function leadsNeedingEnrichment(limit, staleDays) {
  const cutoff = new Date(Date.now() - (staleDays || 30) * 86400000)
    .toISOString().slice(0, 10);
  const r = await q(
    `SELECT id, name, email, website, top_app, country, contact_name, linkedin_url
       FROM leads
      WHERE trim(website) <> ''
        AND (trim(contact_name) = '' OR trim(linkedin_url) = '')
        AND (site_checked_at = '' OR site_checked_at < $1)
        AND outreach <> 'Block List'
      ORDER BY opportunity DESC, id ASC
      LIMIT $2`,
    [cutoff, Math.max(1, Math.min(1000, limit || 100))]
  );
  return r.rows;
}

/** How much contact detail we actually have — drives the "is this worth paying for" call. */
async function contactCoverage() {
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE trim(website) <> '')::int      AS with_site,
            count(*) FILTER (WHERE trim(contact_name) <> '')::int AS with_name,
            count(*) FILTER (WHERE contact_name_source = 'site')::int AS name_verified,
            count(*) FILTER (WHERE trim(linkedin_url) <> '')::int AS with_linkedin,
            count(*) FILTER (WHERE trim(country) <> '')::int      AS with_country
       FROM leads`
  );
  return r.rows[0] || { total: 0, with_site: 0, with_name: 0, name_verified: 0, with_linkedin: 0, with_country: 0 };
}

async function deleteLead(id) {
  await q('DELETE FROM events WHERE lead_id = $1', [id]);
  await q('DELETE FROM leads WHERE id = $1', [id]);
}

async function countSendable() {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM leads
     WHERE outreach = '' AND email <> '' AND grp NOT IN ($1,$2)`,
    [config.groups.blockList, config.groups.replied]
  );
  return r.rows[0].n;
}

/* ----------------------------------------------------------------- events */

async function logEvent(leadId, type) {
  await q('INSERT INTO events (lead_id, type, day) VALUES ($1,$2,$3)', [leadId, type, todayStamp()]);
}

async function countToday(types) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM events WHERE day = $1 AND type = ANY($2)`,
    [todayStamp(), types]
  );
  return r.rows[0].n;
}

/* --------------------------------------------------------------- settings */

async function getSetting(key, dflt) {
  const r = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : dflt;
}
async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

module.exports = {
  pool, q, init, allLeads, insertLead, updateLead, dedupIndex, clearLeads, deleteLead,
  countDuplicates, removeDuplicates, appendApp, duplicateGroups, mergeByEmail,
  deleteExtrasByEmail, mergeAllDuplicates, backfillBlankNames,
  leadsNeedingEnrichment, contactCoverage,
  countSendable, logEvent, countToday, getSetting, setSetting, config
};
