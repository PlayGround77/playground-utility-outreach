'use strict';

const config = require('../config');
const db = require('../db');
const email = require('../email');
const templates = require('../templates');
const criteria = require('../criteria');
const { screenReason } = require('../guards');
const liveMode = require('../livemode');
const t = require('../time');

function log(m) { console.log('[sender] ' + m); }

/** Dashboard "Daily send quota" override wins if set (>0); else the warm-up ramp. */
async function dailyQuota() {
  const crit = await criteria.get();
  if (crit.dailyQuotaOverride > 0) return crit.dailyQuotaOverride;
  const ramp = config.sender.ramp;
  const start = new Date(config.sender.rampStartDate + 'T00:00:00Z');
  const weeks = Math.floor((Date.now() - start.getTime()) / (7 * 86400000));
  return ramp[Math.min(Math.max(weeks, 0), ramp.length - 1)];
}

function withinWindow() {
  if (config.sender.skipWeekdays.includes(t.weekday())) return false;
  const h = t.hour();
  return h >= config.sender.windowStartHour && h < config.sender.windowEndHour;
}

function remainingRunsToday() {
  const minsLeft = config.sender.windowEndHour * 60 - (t.hour() * 60 + t.minute());
  return Math.max(1, Math.ceil(minsLeft / 15));
}

function jitter(dry) {
  if (dry) return Promise.resolve();
  const { jitterMinSec: lo, jitterMaxSec: hi } = config.sender;
  return t.sleep((lo + Math.floor(Math.random() * (hi - lo + 1))) * 1000);
}

function blocked(lead) {
  return lead.grp === config.groups.blockList || lead.grp === config.groups.replied;
}

async function alreadyEmailed(emailAddr) {
  const r = await db.q(
    `SELECT 1 FROM leads WHERE lower(email) = lower($1) AND outreach <> '' LIMIT 1`,
    [emailAddr]
  );
  return r.rows.length > 0;
}

async function closeSweep(leads, dry) {
  const S = config.statuses, R = config.responses;
  for (const lead of leads) {
    if (lead.outreach === S.fu2Sent && !lead.response &&
        t.daysBetween(dateStr(lead.fu2_date), t.todayStamp()) >= config.sender.closeAfterDays) {
      if (!dry) {
        await db.updateLead(lead.id, { outreach: S.sequenceClosed, response: R.noResponse });
        await db.logEvent(lead.id, 'close');
      }
      log('CLOSE ' + lead.name);
    }
  }
}

function dateStr(d) {
  if (!d) return '';
  if (d instanceof Date) return t.todayStamp(d);
  return String(d).slice(0, 10);
}

async function processFollowups(leads, type, budget, seen, dry) {
  if (budget <= 0) return 0;
  const S = config.statuses;
  const isFU2 = type === 'fu2';
  const due = leads.filter((l) => {
    if (!l.email || !l.message_id || l.response || blocked(l)) return false;
    if (isFU2) return l.outreach === S.fu1Sent && t.daysBetween(dateStr(l.fu1_date), t.todayStamp()) >= config.sender.fu2AfterDays;
    return l.outreach === S.emailSent && t.daysBetween(dateStr(l.initial_date), t.todayStamp()) >= config.sender.fu1AfterDays;
  });

  let sent = 0;
  for (const lead of due) {
    if (sent >= budget) break;
    if (seen.has(lead.email.toLowerCase())) continue;
    const reason = screenReason({ name: lead.name, email: lead.email, notes: lead.notes, topApp: lead.top_app });
    if (reason) { log(`[SKIP-FU] ${lead.name} :: ${reason}`); continue; }
    seen.add(lead.email.toLowerCase());

    const tmpl = isFU2 ? templates.fu2(lead) : templates.fu1(lead);
    if (dry) {
      log(`[DRY] FU(${type}) -> ${lead.email} (${lead.name})`);
    } else {
      await email.send({ to: lead.email, subject: `Quick question about ${lead.name}`, html: tmpl.html, inReplyTo: lead.message_id, threadId: lead.thread_id });
      const fields = isFU2
        ? { outreach: S.fu2Sent, fu2_date: t.todayStamp() }
        : { outreach: S.fu1Sent, fu1_date: t.todayStamp() };
      await db.updateLead(lead.id, fields);
      await db.logEvent(lead.id, type);
    }
    sent++;
    await jitter(dry);
  }
  if (sent) log(`${type.toUpperCase()} sent: ${sent}`);
  return sent;
}

async function processNew(leads, budget, seen, dry) {
  if (budget <= 0) return 0;
  const S = config.statuses;
  const candidates = leads
    .filter((l) => !l.outreach && l.email && !blocked(l))
    .sort((a, b) => (Number(b.opportunity) - Number(a.opportunity)) || (Number(b.priority) - Number(a.priority)));

  const dateLabel = t.dayMonthLabel();
  let sent = 0;
  for (const lead of candidates) {
    if (sent >= budget) break;
    const em = lead.email.toLowerCase();
    if (seen.has(em)) continue;

    const reason = screenReason({ name: lead.name, email: lead.email, notes: lead.notes, topApp: lead.top_app });
    if (reason) { log(`[SKIP] ${lead.name} :: ${reason}`); continue; }
    if (await alreadyEmailed(em)) { log(`[DUP] already emailed ${em}`); seen.add(em); continue; }
    seen.add(em);

    const tmpl = templates.initial(lead);
    if (dry) {
      log(`[DRY] NEW -> ${lead.email} (${lead.name}) | subj: ${tmpl.subject}`);
    } else {
      const result = await email.send({ to: lead.email, subject: tmpl.subject, html: tmpl.html });
      await db.updateLead(lead.id, {
        outreach: S.emailSent, initial_date: t.todayStamp(), grp: dateLabel, message_id: result.messageId || '', thread_id: result.threadId || ''
      });
      await db.logEvent(lead.id, 'initial');
    }
    sent++;
    await jitter(dry);
  }
  if (sent) log(`NEW sent: ${sent}`);
  return sent;
}

async function runSender(opts) {
  opts = opts || {};
  const mode = await db.getSetting('send_mode', 'manual');
  // Scheduler only auto-sends in 'auto'. Paused/Manual keep it idle.
  if (opts.scheduled && mode !== 'auto') {
    log(`Scheduler idle (mode=${mode}).`);
    return;
  }
  // A manual batch ("Send tick") is refused while paused.
  if (!opts.scheduled && mode === 'paused') {
    log('Sending is PAUSED — resume to send.');
    return;
  }
  if (!withinWindow()) { log('Outside sending window — skip.'); return; }

  const quota = await dailyQuota();
  const sentToday = await db.countToday(['initial', 'fu1', 'fu2']);
  const bouncedToday = await db.countToday(['bounce']);
  const remaining = quota - sentToday;

  if (sentToday >= config.safety.minSendsForBrake &&
      bouncedToday / Math.max(sentToday, 1) > config.safety.bounceRatioMax) {
    log(`⛔ Bounce brake engaged (${bouncedToday}/${sentToday}) — pausing.`);
    return;
  }

  const dry = await liveMode.isDry();
  const leads = await db.allLeads();
  await closeSweep(leads, dry);
  if (remaining <= 0) { log(`Quota reached (${sentToday}/${quota}).`); return; }

  let budget = Math.min(remaining, Math.max(1, Math.ceil(remaining / remainingRunsToday())), config.sender.perRunCap);
  const seen = new Set();
  budget -= await processFollowups(leads, 'fu2', budget, seen, dry);
  if (budget > 0) budget -= await processFollowups(leads, 'fu1', budget, seen, dry);
  if (budget > 0) await processNew(leads, budget, seen, dry);
}

/**
 * Manual, per-lead send: sends the NEXT email in the sequence to one lead,
 * chosen by the human. Bypasses the daily window/quota (deliberate action) but
 * still respects DRY_RUN (master safety), the guard firewall, and block status.
 * Returns { step } on success or { error } if it couldn't send.
 */
async function sendOne(leadId) {
  const S = config.statuses;
  const leads = await db.allLeads();
  const lead = leads.find((l) => String(l.id) === String(leadId));
  if (!lead) return { error: 'not found' };
  if (!lead.email) return { error: 'no email' };
  if (blocked(lead)) return { error: 'blocked' };
  if (lead.response) return { error: 'has a response already (sequence stopped)' };

  const reason = screenReason({ name: lead.name, email: lead.email, notes: lead.notes, topApp: lead.top_app });
  if (reason) return { error: 'guard: ' + reason };

  let step;
  if (!lead.outreach) step = 'initial';
  else if (lead.outreach === S.emailSent) step = 'fu1';
  else if (lead.outreach === S.fu1Sent) step = 'fu2';
  else return { error: 'sequence already complete for this lead' };

  if (await liveMode.isDry()) { log(`[DRY] manual send ${step} -> ${lead.email} (${lead.name})`); return { dry: true, step }; }

  if (step === 'initial') {
    const tmpl = templates.initial(lead);
    const result = await email.send({ to: lead.email, subject: tmpl.subject, html: tmpl.html });
    await db.updateLead(lead.id, {
      outreach: S.emailSent, initial_date: t.todayStamp(), grp: t.dayMonthLabel(), message_id: result.messageId || '', thread_id: result.threadId || ''
    });
    await db.logEvent(lead.id, 'initial');
  } else {
    const tmpl = step === 'fu2' ? templates.fu2(lead) : templates.fu1(lead);
    await email.send({ to: lead.email, subject: `Quick question about ${lead.name}`, html: tmpl.html, inReplyTo: lead.message_id });
    await db.updateLead(lead.id, step === 'fu2'
      ? { outreach: S.fu2Sent, fu2_date: t.todayStamp() }
      : { outreach: S.fu1Sent, fu1_date: t.todayStamp() });
    await db.logEvent(lead.id, step);
  }
  log(`manual send ${step} -> ${lead.email} (${lead.name})`);
  return { step };
}

module.exports = { runSender, sendOne, dailyQuota };

if (require.main === module) {
  (async () => {
    await db.init();
    await runSender();
    await db.pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
