'use strict';

const config = require('./config');
const db = require('./db');
const liveMode = require('./livemode');
const { makeApp } = require('./server');
const scheduler = require('./scheduler');

async function main() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (add a Postgres service in Railway).');
  await db.init();
  console.log('[db] ready');

  const app = makeApp();
  app.listen(config.port, () => console.log(`[web] dashboard on :${config.port}`));

  scheduler.start();

  const dry = await liveMode.isDry();
  console.log(`[boot] ${config.brand.companyName} Utility Outreach up. dry=${dry} (toggle from the dashboard, or set DRY_RUN in Railway as the first-boot default).`);
  if (dry) console.log('[boot] Dry mode is ON — no email is sent.');
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
