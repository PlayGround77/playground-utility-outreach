'use strict';

const config = require('./config');
const db = require('./db');
const { makeApp } = require('./server');
const scheduler = require('./scheduler');

async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (add a Postgres service in Railway).');
  await db.init();
  console.log('[db] ready');

  const app = makeApp();
  app.listen(config.port, () => console.log(`[web] dashboard on :${config.port}`));

  scheduler.start();

  console.log(`[boot] ${config.brand.companyName} Utility Outreach up. DRY_RUN=${config.DRY_RUN}.`);
  if (config.DRY_RUN) console.log('[boot] DRY_RUN is ON — no email is sent and no leads are written by the sender.');
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
