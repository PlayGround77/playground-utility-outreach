'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const { runSender } = require('./jobs/sender');
const { runReplyWatcher } = require('./jobs/replywatcher');
const { runPoolRefill } = require('./jobs/refill');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeEqual(a, b) {
  const ba = Buffer.from(a || ''), bb = Buffer.from(b || '');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req, res, next) {
  if (!config.dashboard.pass) {
    res.status(503).send('Dashboard locked: set DASHBOARD_PASS env var.');
    return;
  }
  const h = req.headers.authorization || '';
  const [scheme, encoded] = h.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(user, config.dashboard.user) && safeEqual(pass, config.dashboard.pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Outreach"').status(401).send('Auth required');
}

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1rem;background:Canvas;color:CanvasText}
  h1{font-size:1.2rem;margin:.2rem 0}
  .bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0 1rem}
  .pill{padding:.15rem .5rem;border-radius:999px;border:1px solid;font-size:.8rem}
  .live{background:#fee;color:#900;border-color:#c00}.dry{background:#eef;color:#036;border-color:#69c}
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  th,td{border:1px solid #8884;padding:.3rem .4rem;text-align:left;vertical-align:top}
  th{position:sticky;top:0;background:Canvas}
  .stat{display:inline-block;margin-right:1rem}
  button{font:inherit;padding:.2rem .5rem;cursor:pointer}
  form{display:inline}
  .wrap{overflow-x:auto}
  a{color:LinkText}
</style></head><body>${inner}</body></html>`;
}

function makeApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (req, res) => res.send('ok'));

  app.use(basicAuth);

  app.get('/', async (req, res) => {
    try {
      const leads = await db.allLeads();
      const S = config.statuses;
      const stat = { queue: 0, sent: 0, fu1: 0, fu2: 0, closed: 0, replied: 0, blocked: 0 };
      for (const l of leads) {
        if (l.grp === config.groups.blockList) stat.blocked++;
        else if (!l.outreach && l.email) stat.queue++;
        if (l.outreach === S.emailSent) stat.sent++;
        else if (l.outreach === S.fu1Sent) stat.fu1++;
        else if (l.outreach === S.fu2Sent) stat.fu2++;
        else if (l.outreach === S.sequenceClosed) stat.closed++;
        if (l.response === config.responses.respond) stat.replied++;
      }
      const sentToday = await db.countToday(['initial', 'fu1', 'fu2']);

      const rows = leads.slice(0, 500).map((l) => `<tr>
        <td>${esc(l.name)}</td>
        <td>${l.store_link ? `<a href="${esc(l.store_link)}" target="_blank">${esc(l.email)}</a>` : esc(l.email)}</td>
        <td>${esc(l.outreach)}</td>
        <td><b>${esc(l.response)}</b></td>
        <td>${esc(l.top_app)}</td>
        <td>${esc(l.priority)}</td>
        <td>${esc(l.grp)}</td>
        <td>
          <form method="post" action="/action/${l.id}/respond"><input type="hidden" name="value" value="${esc(config.responses.bookedCall)}"><button>📞 Booked</button></form>
          <form method="post" action="/action/${l.id}/respond"><input type="hidden" name="value" value="${esc(config.responses.notRelevant)}"><button>🚫 Not rel.</button></form>
          <form method="post" action="/action/${l.id}/block"><button>⛔ Block</button></form>
        </td></tr>`).join('');

      const mode = config.DRY_RUN
        ? '<span class="pill dry">DRY RUN — nothing is sent</span>'
        : '<span class="pill live">LIVE — sending real email</span>';

      res.send(page('Outreach', `
        <h1>${esc(config.brand.companyName)} Utility Outreach</h1>
        <div class="bar">${mode}
          <form method="post" action="/run/refill"><button>Source now</button></form>
          <form method="post" action="/run/send"><button>Send tick now</button></form>
          <form method="post" action="/run/watch"><button>Check replies now</button></form>
        </div>
        <div class="bar">
          <span class="stat">Sent today: <b>${sentToday}</b></span>
          <span class="stat">Queue: <b>${stat.queue}</b></span>
          <span class="stat">Sent: <b>${stat.sent}</b></span>
          <span class="stat">FU1: <b>${stat.fu1}</b></span>
          <span class="stat">FU2: <b>${stat.fu2}</b></span>
          <span class="stat">Replied: <b>${stat.replied}</b></span>
          <span class="stat">Closed: <b>${stat.closed}</b></span>
          <span class="stat">Blocked: <b>${stat.blocked}</b></span>
        </div>
        <div class="wrap"><table>
          <tr><th>Studio</th><th>Email</th><th>Outreach</th><th>Response</th><th>Top App</th><th>Priority</th><th>Group</th><th>Actions</th></tr>
          ${rows || '<tr><td colspan="8">No leads yet — click “Source now”.</td></tr>'}
        </table></div>
        <p style="opacity:.6">Showing up to 500 rows. Mode is controlled by the DRY_RUN env var in Railway.</p>
      `));
    } catch (e) {
      res.status(500).send('Error: ' + esc(e.message));
    }
  });

  app.post('/action/:id/respond', async (req, res) => {
    await db.updateLead(Number(req.params.id), { response: String(req.body.value || '') });
    res.redirect('/');
  });
  app.post('/action/:id/block', async (req, res) => {
    await db.updateLead(Number(req.params.id), { grp: config.groups.blockList });
    res.redirect('/');
  });

  // Fire-and-forget job triggers (jobs can run long; don't block the response).
  app.post('/run/refill', (req, res) => { runPoolRefill(true).catch((e) => console.error(e)); res.redirect('/'); });
  app.post('/run/send', (req, res) => { runSender().catch((e) => console.error(e)); res.redirect('/'); });
  app.post('/run/watch', (req, res) => { runReplyWatcher().catch((e) => console.error(e)); res.redirect('/'); });

  return app;
}

module.exports = { makeApp };
