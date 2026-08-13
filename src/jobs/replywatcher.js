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
    const freshReplies = []; // only genuinely new ones get an alert email
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
        const info = (scan.replyInfo && scan.replyInfo.get(em)) || {};
        if (dry) { log(`[DRY] REPLY ${lead.name}`); continue; }

        // "New" = we had not recorded a response for this lead yet. Manual
        // values (Booked a call / Not Relevant) are never overwritten.
        const isNew = !lead.response;
        const patch = {
          reply_snippet: info.snippet || '',
          reply_subject: info.subject || '',
          reply_at: info.date || '',
          reply_thread: info.threadId || ''
        };
        if (isNew) patch.response = R.respond;
        await db.updateLead(lead.id, patch);
        if (isNew) {
          await db.logEvent(lead.id, 'reply');
          freshReplies.push({ lead, info });
        }
        log('REPLY ' + lead.name);
      }
    }

    // Immediate alert so a hot lead isn't missed until the 08:00 summary.
    if (freshReplies.length && config.report.summaryTo) {
      const body = freshReplies.map(({ lead, info }) =>
        `${lead.name} <${lead.email}>\n` +
        (info.subject ? `Subject: ${info.subject}\n` : '') +
        (info.snippet ? `\n"${info.snippet}"\n` : '') +
        (info.threadId ? `\nOpen in Gmail: https://mail.google.com/mail/u/0/#inbox/${info.threadId}\n` : '')
      ).join('\n----------------------------------------\n\n');
      try {
        await email.notify(config.report.summaryTo,
          `💬 ${freshReplies.length} new repl${freshReplies.length === 1 ? 'y' : 'ies'} to your outreach`,
          body + '\n\nSet "Booked a call" or "Not Relevant" on the dashboard once you have read them.');
        log(`alerted on ${freshReplies.length} new reply(ies)`);
      } catch (e) { log('reply alert email failed: ' + e.message); }
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
