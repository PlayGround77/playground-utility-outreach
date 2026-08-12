'use strict';

const config = require('../config');
const db = require('../db');
const email = require('../email');
const liveMode = require('../livemode');

function log(m) { console.log('[watcher] ' + m); }

async function runReplyWatcher() {
  const S = config.statuses, R = config.responses;
  let status = 'ok';
  try {
    const leads = await db.allLeads();
    const active = leads.filter((l) =>
      l.email && [S.emailSent, S.fu1Sent, S.fu2Sent].includes(l.outreach));
    if (!active.length) { log('no active leads'); status = 'ok — no active leads to check'; return; }

    let scan;
    try { scan = await email.scanInbox(30); }
    catch (e) { status = 'error: ' + e.message; log('Gmail scan failed: ' + e.message); return; }

    const dry = await liveMode.isDry();
    let replies = 0, bounces = 0;
    for (const lead of active) {
      const em = lead.email.toLowerCase();
      if (scan.bounceEmails.has(em)) {
        bounces++;
        if (dry) { log(`[DRY] BOUNCE ${lead.name}`); continue; }
        await db.updateLead(lead.id, { response: R.notRelevant, outreach: S.sequenceClosed });
        await db.logEvent(lead.id, 'bounce');
        log('BOUNCE ' + lead.name);
      } else if (scan.replyEmails.has(em)) {
        replies++;
        if (dry) { log(`[DRY] REPLY ${lead.name}`); continue; }
        if (!lead.response) { // never overwrite a manual value
          await db.updateLead(lead.id, { response: R.respond });
          await db.logEvent(lead.id, 'reply');
        }
        log('REPLY ' + lead.name);
      }
    }
    status = `ok — checked ${active.length}, ${replies} repl${replies === 1 ? 'y' : 'ies'}, ${bounces} bounce${bounces === 1 ? '' : 's'}`;
  } catch (e) {
    status = 'error: ' + e.message;
    throw e;
  } finally {
    // Record that a check actually ran, regardless of outcome, so the
    // dashboard can show real proof it's alive (not just that it's scheduled).
    try {
      await db.setSetting('last_watch_run', new Date().toISOString());
      await db.setSetting('last_watch_status', status);
    } catch (e) { log('could not record last-run timestamp: ' + e.message); }
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
