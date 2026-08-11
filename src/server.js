'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const criteria = require('./criteria');
const email = require('./email');
const templates = require('./templates');
const { screenReason } = require('./guards');
const t = require('./time');

function appList(l) {
  try { const a = JSON.parse(l.apps_json || '[]'); return Array.isArray(a) ? a.filter(Boolean) : []; }
  catch (e) { return []; }
}
function appBadge(l) {
  const a = appList(l);
  return a.length > 1 ? ` <span class="badge" title="${a.map((x) => x).join(', ').replace(/"/g, '')}">×${a.length}</span>` : '';
}

// Heuristic "not relevant" flag for an existing lead (guard firewall + oversize).
function flagReason(lead, crit) {
  const g = screenReason({ name: lead.name, email: lead.email, notes: '', topApp: lead.top_app, topAppCategory: lead.category });
  if (g) return g;
  if (Number(lead.revenue_month) > crit.revenueMax) return 'revenue_too_high';
  if (crit.installsMax && Number(lead.installs_month) > crit.installsMax * 3) return 'installs_way_over_band';
  if (crit.maxPriority && Number(lead.priority) > crit.maxPriority) return 'too_big (priority ' + Number(lead.priority).toLocaleString('en-US') + ')';
  return '';
}

const { runSender, sendOne, dailyQuota } = require('./jobs/sender');
const { runReplyWatcher } = require('./jobs/replywatcher');
const { runPoolRefill } = require('./jobs/refill');

function windowOpen() {
  if (config.sender.skipWeekdays.includes(t.weekday())) return false;
  const h = t.hour();
  return h >= config.sender.windowStartHour && h < config.sender.windowEndHour;
}
function baseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
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
  const title = name === 'outreach'
    ? 'Outreach status — where this lead is in the sequence. Set automatically as emails go out; change here to override.'
    : 'Response status — set to “Respond” automatically when they reply. You set “Booked a call” / “Not Relevant” yourself.';
  return `<form method="post" action="/action/${id}/set" class="sel">
    <select name="${name}" title="${esc(title)}" onchange="this.form.submit()"${style}>${optionList(opts, current)}</select>
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
  .badge{display:inline-block;padding:0 .4rem;border-radius:999px;background:var(--chip);color:var(--accent);font-size:.72rem;font-weight:600}
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
      const gmailConnected = await email.isConnected();
      const redirectUri = baseUrl(req) + '/oauth/callback';

      // View filter (defaults to hiding the Block List).
      const view = req.query.view || 'nonblocked';
      const BL = config.groups.blockList, RP = config.groups.replied;
      const R = config.responses;
      let shown = leads;
      if (view === 'nonblocked') shown = leads.filter((l) => l.grp !== BL);
      else if (view === 'queue') shown = leads.filter((l) => !l.outreach && l.email && l.grp !== BL && l.grp !== RP);
      else if (view === 'contacted') shown = leads.filter((l) => l.outreach && l.grp !== BL);
      else if (view === 'replied') shown = leads.filter((l) => l.response === R.respond);
      else if (view === 'blocked') shown = leads.filter((l) => l.grp === BL);
      // 'all' → no filter

      const appCell = (l) => l.store_link
        ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">${esc(l.top_app || l.name)}</a>`
        : esc(l.top_app || '');

      const rows = shown.slice(0, 500).map((l) => `<tr>
        <td title="${esc(l.name)}"><input type="checkbox" class="rowchk" name="ids" value="${l.id}" form="bulkform"> <b>${esc(l.name)}</b></td>
        <td class="ell" title="${esc(l.top_app || l.name)}">${appCell(l)}${appBadge(l)}</td>
        <td class="num"><b style="color:${l.opportunity >= 70 ? '#059669' : l.opportunity >= 45 ? '#b45309' : 'inherit'}">${num(l.opportunity)}</b></td>
        <td class="muted">${esc(l.category)}</td>
        <td class="num">${num(l.installs_day)}</td>
        <td class="num">${num(l.installs_total)}</td>
        <td class="num">${num(l.apps_count)}</td>
        <td class="num">$${num(l.revenue_month)}</td>
        <td class="num">${Number(l.rev_per_install) ? '$' + Number(l.rev_per_install).toFixed(3) : '$0'}</td>
        <td class="num">${Number(l.rating_avg) ? '★' + Number(l.rating_avg).toFixed(1) + ' <span class="muted">(' + num(l.rating_count) + ')</span>' : ''}</td>
        <td class="num">${num(l.priority)}</td>
        <td class="ell" title="${esc(l.email)}">${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''}</td>
        <td>${l.store_link ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">↗</a>` : ''}</td>
        <td>${selectCell(l.id, 'outreach', OUTREACH_OPTS, l.outreach)}</td>
        <td>${selectCell(l.id, 'response', RESPONSE_OPTS, l.response)}</td>
        <td class="muted">${esc(l.grp)}</td>
        <td style="white-space:nowrap">
          <form method="get" action="/preview/${l.id}"><button title="See the exact email that will be sent to this lead">👁 Preview</button></form>
          <form method="post" action="/action/${l.id}/send" onsubmit="return confirm('Send the next email in the sequence to this lead now?')"><button class="send" title="Send the next email (initial → FU1 → FU2) to THIS lead now. Respects DRY_RUN.">✉ Send</button></form>
          <form method="post" action="/action/${l.id}/block"><button title="Move to Block List — never contacted again, removed from sending & future sourcing">⛔ Block</button></form>
          <form method="post" action="/action/${l.id}/delete" onsubmit="return confirm('Delete this lead permanently? (Block is better for junk — it also prevents re-sourcing.)')"><button title="Delete this lead permanently from the database">🗑</button></form>
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
      const gmailPill = gmailConnected
        ? '<span class="pill auto">Gmail ✓</span>'
        : '<span class="pill live">Gmail not connected</span>';
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
          ${mode} ${sendPill} ${gmailPill}
          <div class="toolbar">
            <form method="post" action="/run/refill"><button class="primary" title="Fetch new utility-app studios from AppStoreSpy using the search criteria below, screen them, and add them as leads">Source now</button></form>
            <form method="post" action="/run/send"><button title="Send one paced batch now to leads in the queue — respects the daily quota, the send window, and DRY_RUN">Send tick</button></form>
            <form method="post" action="/run/watch"><button title="Scan the inbox now for replies and bounces and update lead statuses">Check replies</button></form>
            <span class="seg">${modeCtl}</span>
            <form method="post" action="/test-email"><button title="Send a test email to your own inbox to verify Gmail works (bypasses DRY, only emails you)">✉ Test to me</button></form>
            <form method="get" action="/duplicates"><button title="Review & merge duplicate leads (same email) — combine their apps into one">🔁 Duplicates</button></form>
            <form method="get" action="/audit"><button title="Find possibly-irrelevant leads (giants, junk) to review and block">🔎 Audit</button></form>
            <form method="post" action="/admin/clear" onsubmit="return confirm('Delete ALL leads and events? This cannot be undone.')"><button title="Delete all leads to start fresh">🗑 Clear</button></form>
          </div>
        </header>

        ${msg ? `<div class="banner">${msg}</div>` : ''}

        ${!gmailConnected ? `<div class="banner">📧 <b>Gmail is not connected</b> — no email can be sent until you connect it.
          ${config.google.clientId
            ? '<form method="get" action="/oauth/start" style="display:inline;margin-left:.5rem"><button class="primary">🔗 Connect Gmail</button></form>'
            : ' Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Railway first (see setup).'}
          <div style="font-size:.8rem;margin-top:.4rem;opacity:.85">In Google Cloud, register this exact Authorized redirect URI: <code>${esc(redirectUri)}</code></div>
        </div>` : ''}

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
              <label>All-time installs — min<input name="installsTotalMin" value="${esc(crit.installsTotalMin)}"></label>
              <label>All-time installs — max<input name="installsTotalMax" value="${esc(crit.installsTotalMax)}"></label>
              <label>Min rating (0–5)<input name="minRating" value="${esc(crit.minRating)}"></label>
              <label>Min # of ratings<input name="minRatingCount" value="${esc(crit.minRatingCount)}"></label>
              <label>Min apps per dev<input name="minApps" value="${esc(crit.minApps)}"></label>
              <label>Max apps per dev (avoid farms)<input name="maxApps" value="${esc(crit.maxApps)}"></label>
              <label>Max revenue / month ($)<input name="revenueMax" value="${esc(crit.revenueMax)}"></label>
              <label>Flag giants above priority<input name="maxPriority" value="${esc(crit.maxPriority)}"></label>
              <label>Pages per category<input name="pagesPerCategory" value="${esc(crit.pagesPerCategory)}"></label>
              <label>Source target (apps)<input name="refillTarget" value="${esc(crit.refillTarget)}"></label>
            </div>
            <button class="primary" title="Save these search criteria to the database; they take effect on the next “Source now” and scheduled refill">Save criteria</button>
            <span class="muted" style="font-size:.78rem">Valid: ${criteria.VALID_CATEGORIES.join(', ')}</span>
          </form>
        </details>

        <form id="bulkform" method="post" action="/bulk"></form>
        <div class="bar" style="margin:.4rem 0">
          <label><input type="checkbox" onclick="document.querySelectorAll('.rowchk').forEach(function(c){c.checked=this.checked}.bind(this))"> Select all shown</label>
          <button form="bulkform" name="action" value="block" onclick="return confirm('Block the selected leads?')">⛔ Block selected</button>
          <button form="bulkform" name="action" value="delete" onclick="return confirm('Delete the selected leads permanently?')">🗑 Delete selected</button>
        </div>
        <form method="get" action="/" style="margin:.4rem 0;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
          <label>View:
            <select name="view" onchange="this.form.submit()">
              ${[['nonblocked', 'Hide blocked'], ['all', 'All'], ['queue', 'Queue (not contacted)'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['blocked', 'Blocked only']]
                .map(([v, l]) => `<option value="${v}"${view === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <span class="muted">Showing ${shown.length} of ${leads.length} leads</span>
        </form>
        <p class="legend">The <b>Studio</b> and <b>Actions</b> columns stay pinned; scroll the table sideways for status &amp; details.</p>
        <div class="card wrap"><table>
          <thead><tr>
            <th>Studio</th><th>App</th><th title="Acquisition Opportunity Score 0–100">Opp</th><th>Category</th><th>Inst/day</th><th>Total inst</th>
            <th>Apps</th><th>Rev/mo</th><th>$/inst</th><th>Rating</th><th>Priority</th><th>Email</th><th>Store</th>
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
        <p class="legend">Showing up to 500 of ${shown.length} matching leads (${leads.length} total).</p>
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
  app.post('/action/:id/delete', async (req, res) => {
    try { await db.deleteLead(Number(req.params.id)); return back(res, 'Lead deleted.'); }
    catch (e) { return back(res, '⚠️ Delete failed: ' + e.message); }
  });
  app.post('/bulk', async (req, res) => {
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    const action = req.body.action;
    let n = 0;
    try {
      for (const id of ids) {
        if (action === 'delete') { await db.deleteLead(id); n++; }
        else if (action === 'block') { await db.updateLead(id, { grp: config.groups.blockList }); n++; }
      }
    } catch (e) { return back(res, '⚠️ Bulk action failed: ' + e.message); }
    return back(res, `${action === 'delete' ? 'Deleted' : 'Blocked'} ${n} selected lead(s).`);
  });
  const back = (res, m) => res.redirect('/?msg=' + encodeURIComponent(m));

  // Preview the exact email that would be sent next to a lead.
  app.get('/preview/:id', async (req, res) => {
    try {
      const leads = await db.allLeads();
      const lead = leads.find((l) => String(l.id) === String(req.params.id));
      if (!lead) return res.status(404).send('Lead not found');
      const S = config.statuses;
      let step, subject, html;
      if (!lead.outreach) { step = 'Initial'; const tp = templates.initial(lead); subject = tp.subject; html = tp.html; }
      else if (lead.outreach === S.emailSent) { step = 'Follow-up 1'; subject = 'Re: Quick question about ' + lead.name; html = templates.fu1(lead).html; }
      else if (lead.outreach === S.fu1Sent) { step = 'Follow-up 2'; subject = 'Re: Quick question about ' + lead.name; html = templates.fu2(lead).html; }
      else { step = 'Done'; }

      if (step === 'Done') {
        return res.send(shell(`<p><a href="/">← Back</a></p><div class="banner">Sequence is complete for <b>${esc(lead.name)}</b> — no further email will be sent.</div>`));
      }
      res.send(shell(`
        <p><a href="/">← Back to list</a></p>
        <h1 style="font-size:1.2rem">Email preview — ${esc(lead.name)}</h1>
        <div class="card" style="padding:1rem;max-width:760px">
          <div><b>To:</b> ${esc(lead.email)}</div>
          <div><b>Next step:</b> ${esc(step)}</div>
          <div><b>Subject:</b> ${esc(subject)}</div>
          <hr style="border:none;border-top:1px solid var(--line);margin:.8rem 0">
          <div style="line-height:1.6">${html}</div>
        </div>
        <p style="margin-top:1rem">
          <form method="post" action="/action/${lead.id}/send" onsubmit="return confirm('Send this email now?')"><button class="send" title="Send this exact email now (respects DRY_RUN)">✉ Send this now</button></form>
          <a href="/" style="margin-left:.6rem">Cancel</a>
        </p>
        <p class="legend">This is exactly what the recipient will receive${config.DRY_RUN ? ' — but DRY_RUN is on, so “Send this now” only simulates.' : '.'}</p>
      `));
    } catch (e) { res.status(500).send('Error: ' + esc(e.message)); }
  });

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

  // Gmail OAuth (HTTPS) — connect the sending mailbox without SMTP.
  app.get('/oauth/start', (req, res) => {
    if (!config.google.clientId) return back(res, '⚠️ Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway first.');
    const o = email.oauthClient(baseUrl(req) + '/oauth/callback');
    const url = o.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']
    });
    res.redirect(url);
  });
  app.get('/oauth/callback', async (req, res) => {
    try {
      if (req.query.error) return back(res, 'Gmail connect cancelled: ' + req.query.error);
      const o = email.oauthClient(baseUrl(req) + '/oauth/callback');
      const { tokens } = await o.getToken(req.query.code);
      if (tokens.refresh_token) {
        await db.setSetting(email.TOKEN_KEY, tokens.refresh_token);
        return back(res, '✅ Gmail connected! Try “✉ Test to me” to verify.');
      }
      return back(res, '⚠️ Connected but Google returned no refresh token. Set the OAuth app to “In production” in Google Cloud, then Connect Gmail again.');
    } catch (e) { return back(res, 'Gmail connect failed: ' + e.message); }
  });

  // ---- Duplicate review + merge ----
  app.get('/duplicates', async (req, res) => {
    try {
      const groups = await db.duplicateGroups();
      if (!groups.length) return res.send(shell('<p><a href="/">← Back to list</a></p><div class="banner">No duplicate leads (same email) found. 🎉</div>'));
      const blocks = groups.map((g) => {
        const rows = g.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.top_app)}</td><td class="num">${num(r.priority)}</td><td>${esc(r.outreach || '—')}</td></tr>`).join('');
        return `<div class="card" style="padding:.8rem 1rem;margin:.6rem 0">
          <div style="margin-bottom:.4rem"><b>${esc(g.email)}</b> — ${g.rows.length} rows</div>
          <div class="wrap"><table><thead><tr><th>Studio</th><th>App</th><th>Priority</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p style="margin:.6rem 0 0">
            <form method="post" action="/duplicates/merge" style="display:inline"><input type="hidden" name="email" value="${esc(g.email)}"><button class="primary" title="Keep one lead and list all their apps in it">Merge (keep 1, list all apps)</button></form>
            <form method="post" action="/duplicates/delete" style="display:inline"><input type="hidden" name="email" value="${esc(g.email)}"><button title="Keep the first, delete the rest">Delete extras</button></form>
          </p></div>`;
      }).join('');
      res.send(shell(`<p><a href="/">← Back to list</a></p>
        <h1 style="font-size:1.2rem">Duplicate leads — review (${groups.length} group${groups.length === 1 ? '' : 's'})</h1>
        <p class="legend">Same email address appears more than once. <b>Merge</b> keeps one lead and combines all their apps into it (so you send one email covering all apps). <b>Delete extras</b> just removes the duplicates.</p>
        <p>
          <form method="post" action="/duplicates/merge-all" onsubmit="return confirm('Merge ALL duplicate groups?')" style="display:inline"><button class="primary">Merge all groups</button></form>
          <form method="post" action="/admin/dedupe" onsubmit="return confirm('Delete extras in ALL groups?')" style="display:inline"><button>Delete all extras</button></form>
        </p>
        ${blocks}`));
    } catch (e) { res.status(500).send('Error: ' + esc(e.message)); }
  });
  app.post('/duplicates/merge', async (req, res) => { try { await db.mergeByEmail(req.body.email); } catch (e) { console.error(e); } res.redirect('/duplicates'); });
  app.post('/duplicates/delete', async (req, res) => { try { await db.deleteExtrasByEmail(req.body.email); } catch (e) { console.error(e); } res.redirect('/duplicates'); });
  app.post('/duplicates/merge-all', async (req, res) => {
    try { const r = await db.mergeAllDuplicates(); return back(res, `🔁 Merged ${r.groups} group(s), removed ${r.removed} duplicate row(s).`); }
    catch (e) { return back(res, '⚠️ Merge failed: ' + e.message); }
  });

  // ---- Audit: find possibly-irrelevant leads ----
  app.get('/audit', async (req, res) => {
    try {
      const crit = await criteria.get();
      const leads = await db.allLeads();
      const flagged = leads.filter((l) => l.grp !== config.groups.blockList)
        .map((l) => ({ l, reason: flagReason(l, crit) })).filter((x) => x.reason);
      if (!flagged.length) return res.send(shell('<p><a href="/">← Back to list</a></p><div class="banner">The audit found no likely-irrelevant leads. 🎉</div>'));
      const rows = flagged.map(({ l, reason }) => `<tr>
        <td><b>${esc(l.name)}</b></td><td>${esc(l.top_app)}</td><td class="num">${num(l.priority)}</td>
        <td>${esc(l.email)}</td><td style="color:#b91c1c">${esc(reason)}</td>
        <td style="white-space:nowrap">
          <form method="post" action="/action/${l.id}/block" style="display:inline"><button>⛔ Block</button></form>
          <form method="post" action="/action/${l.id}/delete" onsubmit="return confirm('Delete this lead?')" style="display:inline"><button>🗑</button></form>
        </td></tr>`).join('');
      res.send(shell(`<p><a href="/">← Back to list</a></p>
        <h1 style="font-size:1.2rem">Audit — possibly-irrelevant leads (${flagged.length})</h1>
        <p class="legend">Flagged by: the guard firewall (China / junk email / brand / top-app), revenue over the cap, installs far over the band, or priority above ${num(crit.maxPriority)} (giants like Google/Samsung). Review and Block/Delete as you judge. Tune the threshold in “Search criteria → Flag giants above priority”.</p>
        <p><form method="post" action="/audit/block-all" onsubmit="return confirm('Block ALL ${flagged.length} flagged leads?')"><button class="primary">⛔ Block all flagged</button></form></p>
        <div class="card wrap"><table><thead><tr><th>Studio</th><th>App</th><th>Priority</th><th>Email</th><th>Reason</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`));
    } catch (e) { res.status(500).send('Error: ' + esc(e.message)); }
  });
  app.post('/audit/block-all', async (req, res) => {
    try {
      const crit = await criteria.get();
      const leads = await db.allLeads();
      let n = 0;
      for (const l of leads) {
        if (l.grp !== config.groups.blockList && flagReason(l, crit)) { await db.updateLead(l.id, { grp: config.groups.blockList }); n++; }
      }
      return back(res, `⛔ Blocked ${n} flagged lead(s).`);
    } catch (e) { return back(res, '⚠️ Block-all failed: ' + e.message); }
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
