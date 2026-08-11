'use strict';

const config = require('../config');
const db = require('../db');
const ass = require('../appstorespy');
const email = require('../email');
const criteria = require('../criteria');
const { screenReason } = require('../guards');
const t = require('../time');

function log(m) { console.log('[refill] ' + m); }
function dedupKey(name, em) {
  return String(name || '').trim().toLowerCase() + '|' + String(em || '').trim().toLowerCase();
}

function screenCandidate(cand, index, crit) {
  if (/\bpublish(er|ing)?\b/i.test(cand.devName)) return 'publisher';
  if (!cand.email) return 'no_email';
  if (index.has(dedupKey(cand.devName, cand.email))) return 'already_on_board';
  if (cand.installsPerMonth < crit.installsMin || cand.installsPerMonth > crit.installsMax) return 'installs_out_of_range';
  if (cand.appsCount < crit.minApps) return 'too_few_apps';
  if (cand.revenuePerMonth > crit.revenueMax) return 'revenue_too_high';
  if (index.has('email:' + cand.email.toLowerCase())) return 'shared_email_farm';
  return screenReason({ name: cand.devName, email: cand.email, notes: '', topApp: cand.topApp, topAppCategory: cand.topAppCategory });
}

async function runPoolRefill(force) {
  const crit = await criteria.get();
  const band = { minPerMonth: crit.installsMin, maxPerMonth: crit.installsMax };
  const target = crit.refillTarget;

  const sendable = await db.countSendable();
  if (!force && sendable >= config.safety.refillFloor) {
    log(`Queue healthy (${sendable} >= ${config.safety.refillFloor}) — stand down.`);
    return { added: 0, standDown: true };
  }
  log(`Queue at ${sendable} — sourcing toward ${target}. categories=${crit.categories.join(',')} band=${crit.installsMin}-${crit.installsMax}/mo`);

  const index = await db.dedupIndex();          // whole-DB dedup (incl. Block List & Replied)
  const grp = 'Pool ' + t.dayMonthLabel();
  const rejects = {};
  const bump = (r) => { rejects[r] = (rejects[r] || 0) + 1; };
  let added = 0, screened = 0;

  const cats = crit.categories;
  let capHit = false;
  try {
    for (const category of cats) {
      if (added >= target || capHit) break;
      for (let page = 1; page <= crit.pagesPerCategory; page++) {
        if (added >= target) break;
        if (!(await ass.underCallCap())) { log('daily API cap reached'); capHit = true; break; }

        let rows;
        try { rows = await ass.queryApps(category, page, 100, band); }
        catch (e) { log(`query ${category} p${page} failed: ${e.message}`); break; }
        if (!rows.length) break;

        for (const raw of rows) {
          if (added >= target) break;
          screened++;
          const appRow = ass.mapAppRow(raw);
          if (!appRow.devId) { bump('no_developer_id'); continue; }
          const devKey = 'dev:' + appRow.devId;
          if (index.has(devKey)) continue;
          index.add(devKey);
          if (/\bpublish(er|ing)?\b/i.test(appRow.devName)) { bump('publisher'); continue; }

          let dev;
          try { dev = await ass.getDeveloper(appRow.devId); }
          catch (e) { bump('dev_fetch_error'); continue; }

          const cand = ass.buildCandidate(appRow, dev);
          const reason = screenCandidate(cand, index, crit);
          if (reason) { bump(reason); continue; }

          // Sourcing always writes to our own DB (safe + needed for review).
          // Only EMAIL sending is gated by DRY_RUN. insertLead skips duplicates.
          const newId = await db.insertLead({
            name: cand.devName, email: cand.email, priority: cand.priority,
            topApp: cand.topApp, storeLink: cand.storeLink, grp, developerId: cand.devId,
            category: cand.topAppCategory, installsDay: cand.installsPerDay,
            installsMonth: cand.installsPerMonth, revenueMonth: cand.revenuePerMonth, appsCount: cand.appsCount
          });
          if (!newId) { bump('duplicate_email'); continue; }
          log(`add "${cand.devName}" <${cand.email}> prio=${cand.priority} top="${cand.topApp}"`);
          index.add(dedupKey(cand.devName, cand.email));
          index.add('email:' + cand.email.toLowerCase());
          added++;
        }
      }
    }
  } catch (e) {
    log('sourcing error: ' + e.message);
  }

  const rejectLines = Object.keys(rejects).sort().map((k) => `  ${k}: ${rejects[k]}`).join('\n') || '  (none)';
  const body = `${config.brand.companyName} Utility Pool Refill\n\nAdded: ${added}\nScreened: ${screened}\n\nRejections:\n${rejectLines}\n`;
  log(`done: +${added} (screened ${screened})`);
  if (!config.DRY_RUN && config.report.summaryTo) {
    try { await email.notify(config.report.summaryTo, `📥 Pool Refill: ${added} studios`, body); } catch (e) { log('summary email failed: ' + e.message); }
  } else {
    log('summary:\n' + body);
  }
  return { added, screened, rejects };
}

module.exports = { runPoolRefill };

if (require.main === module) {
  (async () => {
    await db.init();
    await runPoolRefill(process.argv.includes('--force'));
    await db.pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
