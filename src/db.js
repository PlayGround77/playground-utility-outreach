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
      category      TEXT NOT NULL DEFAULT '',
      installs_day  BIGINT NOT NULL DEFAULT 0,
      installs_month BIGINT NOT NULL DEFAULT 0,
      revenue_month BIGINT NOT NULL DEFAULT 0,
      apps_count    INTEGER NOT NULL DEFAULT 0,
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
    "thread_id TEXT NOT NULL DEFAULT ''"
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
  const r = await q('SELECT * FROM leads ORDER BY priority DESC');
  return r.rows;
}

// Insert a lead, but SKIP if a lead with the same email already exists
// (DB-level duplicate prevention, independent of the in-memory dedup index).
// Returns the new id, or null if it was a duplicate.
async function insertLead(lead) {
  const r = await q(
    `INSERT INTO leads
       (name,email,priority,top_app,store_link,grp,developer_id,
        category,installs_day,installs_month,revenue_month,apps_count)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
     WHERE $2 = '' OR NOT EXISTS (SELECT 1 FROM leads WHERE email <> '' AND lower(email) = lower($2))
     RETURNING id`,
    [lead.name, lead.email, lead.priority || 0, lead.topApp || '', lead.storeLink || '',
      lead.grp || '', lead.developerId || '', lead.category || '',
      lead.installsDay || 0, lead.installsMonth || 0, lead.revenueMonth || 0, lead.appsCount || 0]
  );
  return r.rows.length ? r.rows[0].id : null;
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
  pool, q, init, allLeads, insertLead, updateLead, dedupIndex, clearLeads,
  countDuplicates, removeDuplicates,
  countSendable, logEvent, countToday, getSetting, setSetting, config
};
