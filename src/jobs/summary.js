'use strict';

const config = require('../config');
const db = require('../db');
const email = require('../email');
const { dailyQuota } = require('./sender');
const t = require('../time');

function log(m) { console.log('[summary] ' + m); }

async function runDailySummary() {
  const S = config.statuses;
  const leads = await db.allLeads();
  const c = { sent: 0, fu1: 0, fu2: 0, closed: 0, replied: 0, queue: 0 };
  for (const l of leads) {
    if (l.outreach === S.emailSent) c.sent++;
    else if (l.outreach === S.fu1Sent) c.fu1++;
    else if (l.outreach === S.fu2Sent) c.fu2++;
    else if (l.outreach === S.sequenceClosed) c.closed++;
    if (l.response === config.responses.respond) c.replied++;
    if (!l.outreach && l.email && l.grp !== config.groups.blockList && l.grp !== config.groups.replied) c.queue++;
  }
  const sentToday = await db.countToday(['initial', 'fu1', 'fu2']);
  const bouncedToday = await db.countToday(['bounce']);

  const body =
    `${config.brand.companyName} Utility Outreach — daily summary (${t.todayStamp()})\n\n` +
    `Sent today: ${sentToday} / ${dailyQuota()}\n` +
    `Bounced today: ${bouncedToday}\n` +
    `Replies awaiting you (Respond): ${c.replied}\n` +
    `Queue (sendable): ${c.queue}\n\n` +
    `Totals — Email Sent: ${c.sent}, FU1: ${c.fu1}, FU2: ${c.fu2}, Closed: ${c.closed}\n`;

  if (config.DRY_RUN || !config.report.summaryTo) { log('summary:\n' + body); return; }
  await email.notify(config.report.summaryTo,
    `📊 ${config.brand.companyName} Outreach: ${sentToday} sent, ${c.replied} replies`, body);
  log('summary emailed');
}

module.exports = { runDailySummary };

if (require.main === module) {
  (async () => { await db.init(); await runDailySummary(); await db.pool.end(); })()
    .catch((e) => { console.error(e); process.exit(1); });
}
