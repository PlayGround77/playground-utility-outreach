'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const criteria = require('./criteria');
const email = require('./email');
const t = require('./time');

const { runSender, sendOne, dailyQuota } = require('./jobs/sender');
const { runReplyWatcher } = require('./jobs/replywatcher');
const { runPoolRefill } = require('./jobs/refill');

function windowOpen() {
  if (config.sender.skipWeekdays.includes(t.weekday())) return false;
  const h = t.hour();
  return h >= config.sender.windowStartHour && h < config.sender.windowEndHour;
}

function num(n) { return Number(n || 0).toLocaleString('en-US'); }
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
  if (!config.dashboard.pass) { res.status(503).send('Dashboard locked: set DASHBOARD_PASS env var.'); return; }
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(user, config.dashboard.user) && safeEqual(pass, config.dashboard.pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Outreach"').status(401).send('Auth required');
}

/* ---- status option lists + colors ---- */
const OUTREACH_OPTS = ['', 'Email Sent', 'Follow-up 1 Sent', 'Follow-up 2 Sent', 'Sequence Closed'];
const RESPONSE_OPTS = ['', 'Respond', 'Booked a call', 'Not Relevant', 'No Response'];
const STATUS_COLOR = {
  'Email Sent': '#3b82f6', 'Follow-up 1 Sent': '#f59e0b', 'Follow-up 2 Sent': '#f97316',
  'Sequence Closed': '#6b7280', 'Respond': '#10b981', 'Booked a call': '#059669',
  'Not Relevant': '#ef4444', 'No Response': '#6b7280'
};
function optionList(opts, current) {
  return opts.map((o) =>
    `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o || '—')}</option>`).join('');
}
function selectCell(id, name, opts, current) {
  const c = STATUS_COLOR[current] || '';
  const style = c ? ` style="border-left:4px solid ${c}"` : '';
  return `<form method="post" action="/action/${id}/set" class="sel">
    <select name="${name}" onchange="this.form.submit()"${style}>${optionList(opts, current)}</select>
  </form>`;
}

function shell(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.brand.companyName)} Outreach</title>
<style>
  :root{
    color-scheme:light dark;
    --bg:#f6f7f9; --panel:#ffffff; --ink:#1a1c1f; --muted:#6b7280;
    --line:#e5e7eb; --accent:#4f46e5; --accent-ink:#fff; --chip:#eef2ff; --hover:#f3f4f6;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0f1115; --panel:#171a21; --ink:#e7e9ee; --muted:#9aa3b2;
    --line:#2a2f3a; --accent:#6366f1; --chip:#1e2230; --hover:#1c2029;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .container{max-width:1400px;margin:0 auto;padding:1.2rem}
  header{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;margin-bottom:1rem}
  h1{font-size:1.25rem;margin:0;font-weight:650}
  .pill{padding:.2rem .6rem;border-radius:999px;font-size:.78rem;font-weight:600;border:1px solid}
  .live{background:#fee2e2;color:#991b1b;border-color:#fca5a5}
  .dry{background:#e0f2fe;color:#075985;border-color:#7dd3fc}
  .auto{background:#dcfce7;color:#166534;border-color:#86efac}
  .manual{background:#fef3c7;color:#92400e;border-color:#fcd34d}
  .paused{background:#e5e7eb;color:#374151;border-color:#9ca3af}
  @media (prefers-color-scheme:dark){.live{background:#3b1414;color:#fca5a5}.dry{background:#0c2a3a;color:#7dd3fc}.auto{background:#0f2a17;color:#86efac}.manual{background:#2a2109;color:#fcd34d}.paused{background:#242832;color:#cbd5e1}}
  .seg{display:inline-flex;gap:.25rem}
  .seg button{padding:.4rem .55rem}
  .toolbar{margin-left:auto;display:flex;gap:.5rem;flex-wrap:wrap}
  button{font:inherit;padding:.4rem .7rem;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;transition:.15s}
  button:hover{background:var(--hover)}
  button.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent;font-weight:600}
  button.send{border-color:#10b98188;color:#059669;font-weight:600}
  button.send:hover{background:#10b9811a}
  form{display:inline}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.6rem;margin:.4rem 0 1rem}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.7rem .9rem}
  .tile .n{font-size:1.5rem;font-weight:700;line-height:1}
  .tile .l{color:var(--muted);font-size:.75rem;margin-top:.25rem;text-transform:uppercase;letter-spacing:.03em}
  details.crit{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.6rem 1rem;margin-bottom:1rem}
  details.crit summary{cursor:pointer;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.7rem;margin:.7rem 0}
  label{display:block;font-size:.8rem;color:var(--muted)}
  input{font:inherit;width:100%;padding:.4rem;margin-top:.2rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .wrap{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  th,td{padding:.5rem .6rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{position:sticky;top:0;background:var(--panel);font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);z-index:1}
  tbody tr:hover{background:var(--hover)}
  td.ell{max-width:190px;overflow:hidden;text-overflow:ellipsis}
  /* Pin the Studio (first) and Actions (last) columns so they stay on screen. */
  th:first-child,td:first-child{position:sticky;left:0;background:var(--panel);z-index:2;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  th:last-child,td:last-child{position:sticky;right:0;background:var(--panel);z-index:2;box-shadow:-6px 0 6px -6px rgba(0,0,0,.25)}
  thead th:first-child,thead th:last-child{z-index:3}
  tbody tr:hover td:first-child,tbody tr:hover td:last-child{background:var(--hover)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  select{font:inherit;padding:.25rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
  .sel{display:block;margin:0}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .muted{color:var(--muted)}
  .legend{color:var(--muted);font-size:.82rem;margin:.8rem 0 0}
  .banner{background:var(--chip);border:1px solid var(--accent);border-radius:10px;padding:.6rem .9rem;margin:.2rem 0 1rem;font-weight:500}
  .status{display:flex;gap:1.2rem;flex-wrap:wrap;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.5rem .9rem;margin-bottom:1rem;font-size:.86rem}
  #nexttick{font-variant-numeric:tabular-nums;color:var(--muted)}
</style></head><body><div class="container">${inner}</div></body></html>`;
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
      const st = { queue: 0, sent: 0, fu1: 0, fu2: 0, closed: 0, replied: 0, blocked: 0 };
      for (const l of leads) {
        if (l.grp === config.groups.blockList) st.blocked++;
        else if (!l.outreach && l.email) st.queue++;
        if (l.outreach === S.emailSent) st.sent++;
        else if (l.outreach === S.fu1Sent) st.fu1++;
        else if (l.outreach === S.fu2Sent) st.fu2++;
        else if (l.outreach === S.sequenceClosed) st.closed++;
        if (l.response === config.responses.respond) st.replied++;
      }
      const sentToday = await db.countToday(['initial', 'fu1', 'fu2']);
      const crit = await criteria.get();
      const sendMode = await db.getSetting('send_mode', 'manual');
      const msg = req.query.msg ? esc(String(req.query.msg).slice(0, 300)) : '';
      const wOpen = windowOpen();
      const quota = dailyQuota();
      const dupCount = await db.countDuplicates();

      const appCell = (l) => l.store_link
        ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">${esc(l.top_app || l.name)}</a>`
        : esc(l.top_app || '');

      const rows = leads.slice(0, 500).map((l) => `<tr>
        <td title="${esc(l.name)}"><b>${esc(l.name)}</b></td>
        <td class="ell" title="${esc(l.top_app || l.name)}">${appCell(l)}</td>
        <td class="muted">${esc(l.category)}</td>
        <td class="num">${num(l.installs_day)}</td>
        <td class="num">${num(l.installs_month)}</td>
        <td class="num">${num(l.apps_count)}</td>
        <td class="num">$${num(l.revenue_month)}</td>
        <td class="num">${num(l.priority)}</td>
        <td class="ell" title="${esc(l.email)}">${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''}</td>
        <td>${l.store_link ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">↗</a>` : ''}</td>
        <td>${selectCell(l.id, 'outreach', OUTREACH_OPTS, l.outreach)}</td>
        <td>${selectCell(l.id, 'response', RESPONSE_OPTS, l.response)}</td>
        <td class="muted">${esc(l.grp)}</td>
        <td style="white-space:nowrap">
          <form method="post" action="/action/${l.id}/send" onsubmit="return confirm('Send the next email in the sequence to this lead now?')"><button class="send" title="Send the next email (initial → FU1 → FU2) to THIS lead now. Respects DRY_RUN.">✉ Send</button></form>
          <form method="post" action="/action/${l.id}/block"><button title="Move to Block List — never contacted again, removed from sending & future sourcing">⛔ Block</button></form>
        </td>
      </tr>`).join('');

      const mode = config.DRY_RUN
        ? '<span class="pill dry">DRY RUN · nothing is sent</span>'
        : '<span class="pill live">LIVE · sending real email</span>';
      const PILLS = {
        paused: '<span class="pill paused">PAUSED</span>',
        manual: '<span class="pill manual">MANUAL send</span>',
        auto: '<span class="pill auto">AUTO send</span>'
      };
      const sendPill = PILLS[sendMode] || PILLS.manual;
      const modeBtn = (v, label, title) =>
        `<form method="post" action="/mode"><input type="hidden" name="value" value="${v}"><button class="${sendMode === v ? 'primary' : ''}" title="${title}">${label}</button></form>`;
      const modeCtl =
        modeBtn('paused', '⏸ Pause', 'Stop ALL automatic sending (scheduler + batch)') +
        modeBtn('manual', '✋ Manual', 'No auto-send; you send per lead (✉) or with Send tick') +
        modeBtn('auto', '▶ Auto', 'Scheduler sends automatically every 15 min in the window');

      const tile = (n, l) => `<div class="tile"><div class="n">${n}</div><div class="l">${l}</div></div>`;

      res.send(shell(`
        <header>
          <h1>${esc(config.brand.companyName)} Utility Outreach</h1>
          ${mode} ${sendPill}
          <div class="toolbar">
            <form method="post" action="/run/refill"><button class="primary">Source now</button></form>
            <form method="post" action="/run/send"><button>Send tick</button></form>
            <form method="post" action="/run/watch"><button>Check replies</button></form>
            <span class="seg">${modeCtl}</span>
            <form method="post" action="/test-email"><button title="Send a test email to your own inbox to verify Gmail works (bypasses DRY, only emails you)">✉ Test to me</button></form>
            <form method="post" action="/admin/dedupe" onsubmit="return confirm('Find and remove duplicate leads (same email)? Keeps one per email.')"><button title="Find & remove duplicate leads by email">🔁 Dedupe</button></form>
            <form method="post" action="/admin/clear" onsubmit="return confirm('Delete ALL leads and events? This cannot be undone.')"><button title="Delete all leads to start fresh">🗑 Clear</button></form>
          </div>
        </header>

        ${msg ? `<div class="banner">${msg}</div>` : ''}

        <div class="status">
          <span>Window: <b>${wOpen ? 'OPEN' : 'closed'}</b> (${config.sender.windowStartHour}:00–${config.sender.windowEndHour}:00, Mon–Fri)</span>
          <span>Sent today: <b>${sentToday} / ${quota}</b></span>
          <span>Duplicates: <b>${dupCount}</b>${dupCount ? ' (click 🔁 Dedupe)' : ''}</span>
          <span id="nexttick" data-mode="${sendMode}" data-dry="${config.DRY_RUN ? '1' : '0'}">…</span>
        </div>

        <div class="tiles">
          ${tile(sentToday, 'Sent today')}
          ${tile(st.queue, 'Queue')}
          ${tile(st.sent, 'Email sent')}
          ${tile(st.fu1, 'Follow-up 1')}
          ${tile(st.fu2, 'Follow-up 2')}
          ${tile(st.replied, 'Replied')}
          ${tile(st.closed, 'Closed')}
          ${tile(st.blocked, 'Blocked')}
        </div>

        <details class="crit">
          <summary>🔎 Search criteria — edit &amp; save; affects the next “Source now”</summary>
          <form method="post" action="/criteria">
            <label>Categories (comma-separated Google Play APP categories)
              <input name="categories" value="${esc(crit.categories.join(','))}"></label>
            <div class="grid">
              <label>Installs / month — min<input name="installsMin" value="${esc(crit.installsMin)}"></label>
              <label>Installs / month — max<input name="installsMax" value="${esc(crit.installsMax)}"></label>
              <label>Min apps per studio<input name="minApps" value="${esc(crit.minApps)}"></label>
              <label>Max revenue / month ($)<input name="revenueMax" value="${esc(crit.revenueMax)}"></label>
              <label>Pages per category<input name="pagesPerCategory" value="${esc(crit.pagesPerCategory)}"></label>
              <label>Source target (studios)<input name="refillTarget" value="${esc(crit.refillTarget)}"></label>
            </div>
            <button class="primary">Save criteria</button>
            <span class="muted" style="font-size:.78rem">Valid: ${criteria.VALID_CATEGORIES.join(', ')}</span>
          </form>
        </details>

        <p class="legend">The <b>Studio</b> and <b>Actions</b> (✉ Send / ⛔ Block) columns stay pinned; scroll the table sideways for status &amp; details.</p>
        <div class="card wrap"><table>
          <thead><tr>
            <th>Studio</th><th>App</th><th>Category</th><th>Inst/day</th><th>Inst/mo</th>
            <th>Apps</th><th>Rev/mo</th><th>Priority</th><th>Email</th><th>Store</th>
            <th>Outreach status</th><th>Response status</th><th>Group</th><th></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="14" class="muted">No leads yet — click “Source now”.</td></tr>'}</tbody>
        </table></div>

        <p class="legend">
          Change <b>Outreach</b> / <b>Response</b> status directly from the dropdowns (saved instantly).
          <b>⛔ Block</b> removes a studio from sending &amp; future sourcing.
          Replies are detected automatically and set Response to “Respond”.
        </p>
        <p class="legend">
          <b>MANUAL send</b> = the scheduler never sends on its own. Send per lead with the row’s <b>✉ Send</b> button
          (sends that studio’s next email: initial → FU1 → FU2), or a whole batch with <b>Send tick</b>.
          <b>AUTO send</b> = the scheduler sends automatically every 15 min in the window.
          Either way, <b>nothing is sent while <code>DRY_RUN=true</code></b> (the master safety in Railway) — that is the go-live gate.
        </p>
        <p class="legend">Showing up to 500 of ${leads.length} leads.</p>
        <script>
        (function(){
          var el=document.getElementById('nexttick'); if(!el) return;
          var mode=el.getAttribute('data-mode'), dry=el.getAttribute('data-dry')==='1';
          function pad(n){return (n<10?'0':'')+n;}
          function tick(){
            var d=new Date(), into=(d.getMinutes()%15)*60+d.getSeconds(), left=900-into; if(left<=0)left=900;
            var m=Math.floor(left/60), s=left%60, cd=pad(m)+':'+pad(s);
            var txt = mode==='auto' ? ('⏱ Next auto send in '+cd) : ('⏱ Manual mode — auto tick would run in '+cd+' (idle)');
            if(dry) txt += ' · DRY: nothing is sent';
            el.textContent=txt;
          }
          tick(); setInterval(tick,1000);
        })();
        </script>
      `));
    } catch (e) {
      res.status(500).send('Error: ' + esc(e.message));
    }
  });

  app.post('/action/:id/set', async (req, res) => {
    const patch = {};
    if ('outreach' in req.body) patch.outreach = String(req.body.outreach);
    if ('response' in req.body) patch.response = String(req.body.response);
    if (Object.keys(patch).length) await db.updateLead(Number(req.params.id), patch);
    res.redirect('/');
  });
  app.post('/action/:id/block', async (req, res) => {
    await db.updateLead(Number(req.params.id), { grp: config.groups.blockList });
    res.redirect('/');
  });
  const back = (res, m) => res.redirect('/?msg=' + encodeURIComponent(m));

  // Manual per-lead send: sends the next email in the sequence to one lead.
  app.post('/action/:id/send', async (req, res) => {
    try {
      const r = await sendOne(Number(req.params.id));
      if (r.error) return back(res, '⚠️ Not sent — ' + r.error);
      if (r.dry) return back(res, 'DRY RUN — would send the ' + r.step + ' email now. Set DRY_RUN=false in Railway to actually send.');
      return back(res, '✉ Sent the ' + r.step + ' email (immediately, no queue).');
    } catch (e) { return back(res, '⚠️ Send failed: ' + e.message); }
  });

  // Test email to the owner's own inbox — bypasses DRY (safe: only emails you).
  app.post('/test-email', async (req, res) => {
    const to = config.report.summaryTo || config.gmail.user;
    try {
      await email.notify(to, `${config.brand.companyName} Outreach — test email`,
        'This is a test from your outreach dashboard. If you received this, Gmail sending works. ✅');
      return back(res, '✉ Test email sent to ' + to + ' — check your inbox (and Spam).');
    } catch (e) { return back(res, '⚠️ Test email failed: ' + e.message); }
  });
  // Legacy alias so a stale/cached page (old 📞/🚫 buttons) still works.
  app.post('/action/:id/respond', async (req, res) => {
    await db.updateLead(Number(req.params.id), { response: String(req.body.value || '') });
    res.redirect('/');
  });
  app.post('/criteria', async (req, res) => {
    try { await criteria.set(req.body || {}); } catch (e) { console.error('[criteria]', e.message); }
    res.redirect('/');
  });
  app.post('/mode', async (req, res) => {
    const v = ['paused', 'manual', 'auto'].includes(req.body.value) ? req.body.value : 'manual';
    await db.setSetting('send_mode', v);
    const label = { paused: '⏸ Sending PAUSED — no automatic messages go out.', manual: '✋ Manual mode — you send per lead or with Send tick.', auto: '▶ Auto mode — the scheduler will send automatically.' };
    return back(res, label[v]);
  });
  app.post('/admin/clear', async (req, res) => {
    try { await db.clearLeads(); return back(res, 'All leads cleared.'); }
    catch (e) { return back(res, '⚠️ Clear failed: ' + e.message); }
  });
  app.post('/admin/dedupe', async (req, res) => {
    try { const n = await db.removeDuplicates(); return back(res, `🔁 Removed ${n} duplicate lead${n === 1 ? '' : 's'} (kept one per email).`); }
    catch (e) { return back(res, '⚠️ Dedupe failed: ' + e.message); }
  });

  app.post('/run/refill', (req, res) => {
    runPoolRefill(true).catch((e) => console.error(e));
    back(res, 'Sourcing started — new leads will appear in a moment (refresh the page).');
  });
  // Manual send = human-triggered (not scheduled). Refused while paused.
  app.post('/run/send', async (req, res) => {
    const mode = await db.getSetting('send_mode', 'manual');
    if (mode === 'paused') return back(res, '⏸ Sending is paused. Switch to Manual or Auto first.');
    runSender({ scheduled: false }).catch((e) => console.error(e));
    return back(res, config.DRY_RUN
      ? 'Send tick ran in DRY RUN — nothing sent (see logs). Set DRY_RUN=false to send for real.'
      : 'Send tick triggered — sending a batch now; refresh to see the counters move.');
  });
  app.post('/run/watch', (req, res) => {
    runReplyWatcher().catch((e) => console.error(e));
    back(res, 'Reply/bounce check started.');
  });

  return app;
}

module.exports = { makeApp };
