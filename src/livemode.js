'use strict';

/**
 * Dashboard-controlled live/dry switch. The DRY_RUN env var (Railway) is only
 * the FIRST-BOOT default — once the dashboard toggle is used, its choice
 * (stored in the DB) takes over. This lets going live/dry happen entirely
 * from the dashboard, no Railway visit required.
 */

const db = require('./db');
const config = require('./config');

const KEY = 'dry_run_override'; // '' = unset (use env default), 'true' | 'false' = explicit

async function isDry() {
  const v = await db.getSetting(KEY, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return config.DRY_RUN === true; // no dashboard choice yet -> env default
}

async function setDry(dry) {
  await db.setSetting(KEY, dry ? 'true' : 'false');
}

module.exports = { isDry, setDry };
