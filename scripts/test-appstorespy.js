'use strict';

/**
 * Sourcing self-test. Queries one utility app, fetches its developer, builds and
 * screens a candidate, and prints every step. Costs ~2 AppStoreSpy credits.
 * Run:  node scripts/test-appstorespy.js         (or: npm run test:appstorespy)
 */

const config = require('../src/config');
const ass = require('../src/appstorespy');
const { screenReason } = require('../src/guards');

async function main() {
  if (!config.appStoreSpy.key) throw new Error('APPSTORESPY_KEY not set');
  const cat = config.appStoreSpy.categories[0];
  const rows = await ass.queryApps(cat, 1, 3);
  console.log(`apps returned: ${rows.length} (category ${cat})`);
  if (!rows.length) { console.log('No apps — widen the band or check the category.'); return; }

  console.log('raw app[0]:', JSON.stringify(rows[0]).slice(0, 1000));
  const appRow = ass.mapAppRow(rows[0]);
  console.log('mapped app:', JSON.stringify(appRow));
  if (!appRow.devId) { console.log('⚠️ no developer_id on the app row'); return; }

  const dev = await ass.getDeveloper(appRow.devId);
  console.log('raw developer:', JSON.stringify(dev).slice(0, 1000));

  const cand = ass.buildCandidate(appRow, dev);
  console.log('CANDIDATE:', JSON.stringify(cand));
  const reason = screenReason({ name: cand.devName, email: cand.email, notes: '', topApp: cand.topApp, topAppCategory: cand.topAppCategory });
  console.log('screen result:', reason || 'PASS');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
