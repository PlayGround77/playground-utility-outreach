'use strict';

/**
 * One-off discovery run for a requested "did this studio acquire an app from
 * someone else, rather than build it themselves?" column.
 *
 * We do NOT know yet whether AppStoreSpy exposes anything that could answer
 * that - there is no documented ownership/transfer field, and the dev sandbox
 * this was written in cannot reach api.appstorespy.com (network policy), so
 * the schema has never been inspected live. Guessing a field name and
 * shipping a column on top of it would risk showing a wrong "consolidator"
 * flag on a real acquisition decision - the same reasoning that already keeps
 * this codebase from guessing phone numbers or unverified contact names.
 *
 * This script:
 *   1. Fetches /openapi.json (free - it is the spec, not a search) and prints
 *      every property name on PlayApp/PlayDev that could plausibly relate to
 *      an app changing hands (date/created/transfer/owner/change/history).
 *   2. Requests a few real apps with EVERY property PlayApp declares (paid -
 *      ~1 credit per page) and prints the raw rows, so we can see whether any
 *      of those candidate fields actually has a value, and what it looks like.
 *   3. Does the same for one of those apps' developers.
 *
 * Run:  node scripts/discover-ownership-signal.js
 * Needs APPSTORESPY_KEY set and network access to api.appstorespy.com - run it
 * from Railway or a machine that can reach the API, not from a sandboxed dev
 * session, and paste the output back rather than acting on a guess.
 */

const config = require('../src/config');

const A = config.appStoreSpy;
function headers() { return { 'API-KEY': A.key, 'Content-Type': 'application/json' }; }

const SIGNAL_RE = /date|created|first_seen|firstseen|added|since|transfer|owner|acqui|change|history|previous|prior|origin/i;

async function getSpec() {
  const res = await fetch(A.apiUrl + '/openapi.json');
  if (!res.ok) throw new Error('openapi.json HTTP ' + res.status);
  return res.json();
}

function candidateFields(schema) {
  const props = (schema && schema.properties) || {};
  return Object.keys(props).filter((k) => SIGNAL_RE.test(k));
}

async function main() {
  if (!A.key) throw new Error('APPSTORESPY_KEY not set');

  console.log('--- 1. OpenAPI schema (free) --------------------------------------');
  const spec = await getSpec();
  const schemas = spec.components && spec.components.schemas || {};
  const playApp = schemas.PlayApp || {};
  const playDev = schemas.PlayDev || {};
  console.log('PlayApp fields:', Object.keys(playApp.properties || {}));
  console.log('PlayDev fields:', Object.keys(playDev.properties || {}));

  const appSignals = candidateFields(playApp);
  const devSignals = candidateFields(playDev);
  console.log('\nPlayApp fields that LOOK relevant to a transfer/history signal:', appSignals.length ? appSignals : '(none found)');
  console.log('PlayDev fields that LOOK relevant:', devSignals.length ? devSignals : '(none found)');

  console.log('\n--- 2. A few real apps, every PlayApp field (paid, ~1 credit) -----');
  const allAppFields = Object.keys(playApp.properties || {});
  const cat = A.categories[0];
  const res = await fetch(A.apiUrl + A.endpoint, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      limit: 5, page: 1, sort: '-downloads_daily', country: 'US',
      fields: allAppFields.length ? allAppFields : undefined,
      filter: { published: true, category_type: 'APP', category: cat }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('query HTTP ' + res.status, JSON.stringify(json).slice(0, 500));
  } else {
    (json.data || []).forEach((row, i) => {
      console.log(`\napp[${i}] "${row.name}" (bundle ${row.bundle}):`);
      if (appSignals.length) appSignals.forEach((f) => console.log(`   ${f}:`, row[f]));
      else console.log('   full row:', JSON.stringify(row).slice(0, 800));
    });

    const devId = json.data && json.data[0] && json.data[0].developer_id;
    if (devId) {
      console.log('\n--- 3. That app\'s developer, full PlayDev shape ------------------');
      const dres = await fetch(A.apiUrl + '/play/developers/' + encodeURIComponent(devId), { headers: headers() });
      const dev = await dres.json().catch(() => ({}));
      if (!dres.ok) console.log('developer HTTP ' + dres.status, JSON.stringify(dev).slice(0, 500));
      else console.log(JSON.stringify(dev, null, 2).slice(0, 1500));
    }
  }

  console.log('\n--- done. Paste this output back so the column can be built on a confirmed field, not a guess. ---');
}

main().catch((e) => { console.error(e); process.exit(1); });
