'use strict';

const config = require('../config');
const db = require('../db');
const email = require('../email');
const liveMode = require('../livemode');
const ai = require('../ai');

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
        // Recorded in dry mode too. DRY_RUN means "no email leaves the
        // building" - reading the inbox and writing what we found is
        // observation, and suppressing it left the dashboard blank on the one
        // setting people actually test in.
        await db.updateLead(lead.id, { response: R.notRelevant, outreach: S.sequenceClosed });
        await db.logEvent(lead.id, 'bounce');
        log('BOUNCE ' + lead.name);
      } else if (scan.replyEmails.has(em)) {
        replies++;
        const info = (scan.replyInfo && scan.replyInfo.get(em)) || {};

        // "New" means a message we have not seen before, by timestamp - not
        // "the first reply ever". A lead who answers again after we replied is
        // the case that matters most, and a first-reply-only test misses it
        // entirely: their newest message would sit unread behind a stale one.
        const seenAt = String(lead.last_inbound_at || '');
        const isNewer = !!info.isoAt && info.isoAt > seenAt;
        const isFirst = !lead.response && !seenAt;

        // Gmail is the authority on whether we have answered, not our own
        // stamp: replying from Gmail never touches the dashboard.
        const tid = info.threadId || lead.reply_thread || lead.thread_id || '';
        const ourSent = (scan.sentByThread && scan.sentByThread.get(tid)) || null;
        if (ourSent && ourSent.isoAt > String(lead.last_outbound_at || '')) {
          await db.updateLead(lead.id, { last_outbound_at: ourSent.isoAt });
          lead.last_outbound_at = ourSent.isoAt;
        }

        if (!isNewer && seenAt) { log('REPLY (already seen) ' + lead.name); continue; }

        const patch = {
          reply_snippet: info.snippet || '',
          reply_subject: info.subject || '',
          reply_at: info.date || '',
          reply_thread: info.threadId || '',
          last_inbound_at: info.isoAt || new Date().toISOString(),
          reply_count: Number(lead.reply_count || 0) + 1
        };
        // Response is the operator's own status. Only ever set it automatically
        // on the very first reply - never overwrite a "Booked a call" they set
        // by hand. A later message surfaces through last_inbound_at instead.
        if (isFirst) patch.response = R.respond;
        await db.updateLead(lead.id, patch);
        await db.logEvent(lead.id, 'reply');

        // Best-effort read of the thread + "does this actually need a reply"
        // judgement, computed once here rather than on every dashboard load -
        // a lead mid-diligence or with a call booked often writes something
        // that needs no answer, and the banner should not nag about those.
        // Losing this must never lose the reply itself, so it never blocks or
        // fails the scan.
        try {
          if (await ai.isEnabled()) {
            const thread = await email.fetchThread(patch.reply_thread || tid).catch(() => []);
            const merged = Object.assign({}, lead, patch);
            const t = await ai.triageReply({ lead: merged, thread, replySnippet: patch.reply_snippet });
            if (t.ok) {
              await db.updateLead(lead.id, {
                ai_summary: t.summary, ai_action_needed: t.actionNeeded ? 'yes' : 'no', ai_action_reason: t.reason
              });
            }
          }
        } catch (e) { log('AI triage failed (non-fatal) for ' + lead.name + ': ' + e.message); }

        // Alert on anything we have not shown before, including a follow-up
        // that landed after we answered.
        const afterOurReply = !!lead.last_outbound_at && info.isoAt > lead.last_outbound_at;
        freshReplies.push({ lead, info, afterOurReply });
        log('REPLY ' + (afterOurReply ? '(new, after our answer) ' : '') + lead.name);
      }
    }

    // Immediate alert so a hot lead isn't missed until the 08:00 summary. This
    // is the only outward-facing step here, so this is what dry mode gates.
    // Dashboard-toggleable, separate from the daily summary (same summaryTo
    // address) - turning this off must not also silence the 08:00 digest.
    const alertsOn = await db.getSetting('reply_alert_enabled', 'true') !== 'false';
    if (freshReplies.length && config.report.summaryTo && !dry && alertsOn) {
      const body = freshReplies.map(({ lead, info, afterOurReply }) =>
        `${lead.name} <${lead.email}>${afterOurReply ? '  [replied again after your answer]' : ''}\n` +
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
