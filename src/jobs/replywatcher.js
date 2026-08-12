'use strict';

const config = require('../config');
const db = require('../db');
const email = require('../email');
const liveMode = require('../livemode');

function log(m) { console.log('[watcher] ' + m); }

async function runReplyWatcher() {
  const S = config.statuses, R = config.responses;
  const leads = await db.allLeads();
  const active = leads.filter((l) =>
    l.email && [S.emailSent, S.fu1Sent, S.fu2Sent].includes(l.outreach));
  if (!active.length) { log('no active leads'); return; }

  let scan;
  try { scan = await email.scanInbox(30); }
  catch (e) { log('Gmail scan failed: ' + e.message); return; }

  const dry = await liveMode.isDry();
  for (const lead of active) {
    const em = lead.email.toLowerCase();
    if (scan.bounceEmails.has(em)) {
      if (dry) { log(`[DRY] BOUNCE ${lead.name}`); continue; }
      await db.updateLead(lead.id, { response: R.notRelevant, outreach: S.sequenceClosed });
      await db.logEvent(lead.id, 'bounce');
      log('BOUNCE ' + lead.name);
    } else if (scan.replyEmails.has(em)) {
      if (dry) { log(`[DRY] REPLY ${lead.name}`); continue; }
      if (!lead.response) { // never overwrite a manual value
        await db.updateLead(lead.id, { response: R.respond });
        await db.logEvent(lead.id, 'reply');
      }
      log('REPLY ' + lead.name);
    }
  }
}

module.exports = { runReplyWatcher };

if (require.main === module) {
  (async () => {
    await db.init();
    await runReplyWatcher();
    await db.pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
