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
  // Installs band is enforced at query time (per-app downloads_daily); the stored
  // installs are developer-level totals, so we do NOT re-check the band here.
  if (cand.appsCount < crit.minApps) return 'too_few_apps';
  if (crit.maxApps && cand.appsCount > crit.maxApps) return 'too_many_apps'; // avoid giant farms
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
        try { rows = await ass.queryApps(category, page, 100, crit); }
        catch (e) { log(`query ${category} p${page} failed: ${e.message}`); break; }
        if (!rows.length) break;

        for (const raw of rows) {
          if (added >= target) break;
          screened++;
          const appRow = ass.mapAppRow(raw);
          if (!appRow.devId) { bump('no_developer_id'); continue; }
          const devKey = 'dev:' + appRow.devId;
          // Same developer seen again this run → add this app to their lead's list.
          if (index.has(devKey)) { await db.appendApp('dev', appRow.devId, appRow.appName); continue; }
          index.add(devKey);
          if (/\bpublish(er|ing)?\b/i.test(appRow.devName)) { bump('publisher'); continue; }

          let dev;
          try { dev = await ass.getDeveloper(appRow.devId); }
          catch (e) { bump('dev_fetch_error'); continue; }

          const cand = ass.buildCandidate(appRow, dev);
          const reason = screenCandidate(cand, index, crit);
          if (reason) { bump(reason); continue; }

          // Review-mining (only for keepers, to control API credits): boost the
          // Opportunity Score when users complain about price/ads/willingness to pay.
          if (crit.scanReviews && appRow.appBundle) {
            try {
              const sig = ass.scanReviewSignals(await ass.fetchReviews(appRow.appBundle));
              if (sig.count) {
                cand.reviewSignals = sig.count;
                cand.reviewEvidence = sig.samples.join('  |  ');
                cand.opportunity = Math.min(100, cand.opportunity + Math.min(20, sig.count * 4));
              }
            } catch (e) { /* reviews are optional */ }
          }

          // Sourcing always writes to our own DB (safe + needed for review).
          // Only EMAIL sending is gated by DRY_RUN. insertLead skips duplicates.
          const newId = await db.insertLead({
            name: cand.devName, email: cand.email, priority: cand.priority,
            topApp: cand.topApp, storeLink: cand.storeLink, grp, developerId: cand.devId,
            category: cand.topAppCategory, installsDay: cand.installsPerDay,
            installsMonth: cand.installsPerMonth, revenueMonth: cand.revenuePerMonth, appsCount: cand.appsCount,
            ratingAvg: cand.ratingAvg, ratingCount: cand.ratingCount,
            installsTotal: cand.installsTotal, revPerInstall: cand.revPerInstall,
            hasIap: cand.hasIap, hasAds: cand.hasAds, website: cand.website,
            lastUpdate: cand.lastUpdate, opportunity: cand.opportunity,
            reviewSignals: cand.reviewSignals || 0, reviewEvidence: cand.reviewEvidence || ''
          });
          // Email already exists from a previous run → add this app to it.
          if (!newId) { await db.appendApp('email', cand.email, cand.topApp); bump('merged_into_existing'); continue; }
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
