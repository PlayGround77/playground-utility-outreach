'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const liveMode = require('./livemode');
const criteria = require('./criteria');
const email = require('./email');
const templates = require('./templates');
const { screenReason } = require('./guards');
const people = require('./people');
const apify = require('./apify');
const enrich = require('./enrich');
const replydraft = require('./replydraft');
const ai = require('./ai');
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

/* ---- finding the person behind the app ---- */

// A name read off the studio's own site is evidence; a name split out of an
// email address is a guess. The table always says which, because acting on a
// guess means addressing a stranger by the wrong name.
function contactCell(l) {
  const name = String(l.contact_name || '');
  if (!name) return '<span class="muted" title="No contact name found yet. Turn on site enrichment in Search criteria, or use Find to search by studio and app name instead.">—</span>';
  const verified = l.contact_name_source === 'site';
  const mark = verified ? '✅' : '~';
  const why = verified
    ? 'Read from the studio\'s own website - reliable'
    : 'Guessed from the email address - unverified, do not use it to address them';
  return `<span title="${esc(why)}">${mark} ${esc(name)}</span>`;
}

// LinkedIn searches, not a resolved profile. If the studio published a profile
// link on its own site we show that instead, because that one is actually known.
function findPersonCell(l) {
  if (l.linkedin_url) {
    return `<a href="${esc(l.linkedin_url)}" target="_blank" rel="noopener" title="LinkedIn profile the studio published on its own website - this one is verified">in ✅</a>`;
  }
  const searches = people.linkedinSearches({
    contactName: l.contact_name, studio: l.name, appName: l.top_app, country: l.country
  });
  if (!searches.length) return '<span class="muted" title="Not enough signal to build a useful search">—</span>';
  const links = searches.map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.why)}">${esc(s.label)}</a>`
  ).join('<br>');
  return `<details class="find"><summary title="Ready-made LinkedIn searches for this lead">🔍 ${searches.length}</summary><div class="findbox">${links}</div></details>`;
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
  /* LIVE is the healthy working state -> green. Red is reserved for actual
     problems (.err), so a red pill always means "something needs fixing". */
  .live{background:#dcfce7;color:#166534;border-color:#4ade80}
  .err{background:#fee2e2;color:#991b1b;border-color:#fca5a5}
  .dry{background:#e0f2fe;color:#075985;border-color:#7dd3fc}
  .auto{background:#dcfce7;color:#166534;border-color:#86efac}
  .manual{background:#fef3c7;color:#92400e;border-color:#fcd34d}
  .paused{background:#e5e7eb;color:#374151;border-color:#9ca3af}
  @media (prefers-color-scheme:dark){.live{background:#0f2a17;color:#86efac}.err{background:#3b1414;color:#fca5a5}.dry{background:#0c2a3a;color:#7dd3fc}.auto{background:#0f2a17;color:#86efac}.manual{background:#2a2109;color:#fcd34d}.paused{background:#242832;color:#cbd5e1}}
  .seg{display:inline-flex;gap:.25rem}
  .seg button{padding:.4rem .55rem}
  .badge{display:inline-block;padding:0 .4rem;border-radius:999px;background:var(--chip);color:var(--accent);font-size:.72rem;font-weight:600}
  .toolbar{margin-left:auto;display:flex;gap:.5rem;flex-wrap:wrap}
  .bar{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
  button{font:inherit;padding:.4rem .7rem;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;transition:.15s}
  button:hover{background:var(--hover)}
  button.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent;font-weight:600}
  button.send{border-color:#10b98188;color:#059669;font-weight:600}
  button.send:hover{background:#10b9811a}
  form{display:inline}
  /* Forms that hold real stacked content, not just a button. Without this the
     global inline rule above leaves them with no height, and the next card
     renders on top of them. */
  form.stack{display:block}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.6rem;margin:.4rem 0 1rem}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.7rem .9rem}
  .tile .n{font-size:1.5rem;font-weight:700;line-height:1}
  .tile .l{color:var(--muted);font-size:.75rem;margin-top:.25rem;text-transform:uppercase;letter-spacing:.03em}
  details.crit{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:.6rem 1rem;margin-bottom:1rem}
  details.crit summary{cursor:pointer;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.7rem;margin:.7rem 0}
  .grid label{display:block;font-size:.8rem;color:var(--muted)}
  .bar label{display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem}
  .help{font-size:.75rem;color:var(--muted);display:block;margin-top:.15rem}
  input{font:inherit;padding:.4rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
  .grid input{width:100%;margin-top:.2rem}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .wrap{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  th,td{padding:.5rem .6rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{position:sticky;top:0;background:var(--panel);font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);z-index:1}
  tbody tr:hover{background:var(--hover)}
  td.ell{max-width:190px;overflow:hidden;text-overflow:ellipsis}
  /* Find-person popover. Scoped to .find so it cannot leak into other <details>. */
  details.find{position:relative}
  details.find>summary{cursor:pointer;list-style:none;white-space:nowrap}
  details.find>summary::-webkit-details-marker{display:none}
  details.find .findbox{position:absolute;right:0;z-index:20;background:#fff;border:1px solid #d1d5db;
    border-radius:6px;padding:.5rem .6rem;box-shadow:0 6px 18px rgba(0,0,0,.15);white-space:nowrap;font-size:.8rem;line-height:1.7}
  details.find .findbox a{display:block}
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
  .wrap{cursor:grab;-webkit-overflow-scrolling:touch}
  .wrap.dragging{cursor:grabbing;user-select:none}
  .wrap.dragging *{pointer-events:none}
</style></head><body><div class="container">${inner}</div>
<script>
(function(){
  // Drag-to-scroll (click-and-hold, then move) for any wide table wrapper.
  document.querySelectorAll('.wrap').forEach(function(el){
    var down=false, moved=false, startX=0, startScroll=0;
    el.addEventListener('mousedown', function(e){
      down=true; moved=false; startX=e.pageX; startScroll=el.scrollLeft;
    });
    window.addEventListener('mousemove', function(e){
      if(!down) return;
      var dx=e.pageX-startX;
      if(Math.abs(dx)>4 && !moved){ moved=true; el.classList.add('dragging'); }
      if(moved){ el.scrollLeft=startScroll-dx; e.preventDefault(); }
    });
    window.addEventListener('mouseup', function(){
      if(moved) el.classList.remove('dragging');
      down=false; moved=false;
    });
  });
})();
</script>
</body></html>`;
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
      const quota = await dailyQuota();
      const dry = await liveMode.isDry();
      const dupCount = await db.countDuplicates();
      const blankNameCount = leads.filter((l) => !String(l.name || '').trim()).length;
      // How much contact detail we actually hold — this is the number that says
      // whether paying for external enrichment is worth it yet.
      const cov = await db.contactCoverage();
      cov.needs_enrich = leads.filter((l) =>
        String(l.website || '').trim() &&
        (!String(l.contact_name || '').trim() || !String(l.linkedin_url || '').trim()) &&
        !String(l.site_checked_at || '').trim()).length;
      const lastWatchRun = await db.getSetting('last_watch_run', '');
      const lastWatchStatus = await db.getSetting('last_watch_status', 'never run yet');
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

      // Column filters — free-text search + per-column numeric ranges + platform.
      const qp = req.query;
      const f = {
        q: (qp.q || '').trim().toLowerCase(),
        platform: qp.platform || '',
        outreach: qp.f_outreach || '',
        response: qp.f_response || '',
        oppMin: qp.f_oppMin, oppMax: qp.f_oppMax,
        instMin: qp.f_instMin, instMax: qp.f_instMax,
        ratingMin: qp.f_ratingMin,
        revMax: qp.f_revMax,
        appsMin: qp.f_appsMin, appsMax: qp.f_appsMax,
        prioMax: qp.f_prioMax
      };
      const anyFilterActive = f.q || f.platform || f.outreach || f.response ||
        f.oppMin || f.oppMax || f.instMin || f.instMax || f.ratingMin || f.revMax ||
        f.appsMin || f.appsMax || f.prioMax;
      function num2(v) { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : null; }
      if (anyFilterActive) {
        shown = shown.filter((l) => {
          if (f.q) {
            const hay = [l.name, l.top_app, l.category, l.email].join(' ').toLowerCase();
            if (!hay.includes(f.q)) return false;
          }
          if (f.platform && l.platform !== f.platform) return false;
          if (f.outreach && l.outreach !== f.outreach) return false;
          if (f.response && l.response !== f.response) return false;
          const oppMin = num2(f.oppMin), oppMax = num2(f.oppMax);
          if (oppMin !== null && Number(l.opportunity) < oppMin) return false;
          if (oppMax !== null && Number(l.opportunity) > oppMax) return false;
          const instMin = num2(f.instMin), instMax = num2(f.instMax);
          if (instMin !== null && Number(l.installs_total) < instMin) return false;
          if (instMax !== null && Number(l.installs_total) > instMax) return false;
          const ratingMin = num2(f.ratingMin);
          if (ratingMin !== null && Number(l.rating_avg) < ratingMin) return false;
          const revMax = num2(f.revMax);
          if (revMax !== null && Number(l.revenue_month) > revMax) return false;
          const appsMin = num2(f.appsMin), appsMax = num2(f.appsMax);
          if (appsMin !== null && Number(l.apps_count) < appsMin) return false;
          if (appsMax !== null && Number(l.apps_count) > appsMax) return false;
          const prioMax = num2(f.prioMax);
          if (prioMax !== null && Number(l.priority) > prioMax) return false;
          return true;
        });
      }

      const appCell = (l) => l.store_link
        ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">${esc(l.top_app || l.name)}</a>`
        : esc(l.top_app || '');

      const rows = shown.slice(0, 500).map((l) => `<tr>
        <td title="${esc(l.name)}"><input type="checkbox" class="rowchk" name="ids" value="${l.id}" form="bulkform"> <b>${esc(l.name)}</b></td>
        <td class="ell" title="${esc(l.top_app || l.name)}">${appCell(l)}${appBadge(l)}</td>
        <td title="${l.platform === 'ios' ? 'iOS' : 'Android'}">${l.platform === 'ios' ? '🍎' : '🤖'}</td>
        <td class="num"><b style="color:${l.opportunity >= 70 ? '#059669' : l.opportunity >= 45 ? '#b45309' : 'inherit'}">${num(l.opportunity)}</b>${Number(l.review_signals) ? ` <span class="badge" title="${esc(l.review_evidence)}">💬${l.review_signals}</span>` : ''}</td>
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
        <td>${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener" title="${esc(l.website)}">🌐</a>` : '<span class="muted" title="No website listed — often a solo-dev signal">—</span>'}</td>
        <td class="ell">${contactCell(l)}</td>
        <td class="muted">${esc(l.country)}</td>
        <td>${findPersonCell(l)}</td>
        <td>${selectCell(l.id, 'outreach', OUTREACH_OPTS, l.outreach)}</td>
        <td>${selectCell(l.id, 'response', RESPONSE_OPTS, l.response)}</td>
        <td class="ell" title="${esc(l.reply_snippet)}">${l.reply_snippet
          ? `<a href="/reply/${l.id}" title="Read it and draft an answer that matches what they said">💬 ${esc(l.reply_snippet.slice(0, 60))}…</a>`
          : ''}</td>
        <td class="muted">${esc(l.grp)}</td>
        <td style="white-space:nowrap">
          <form method="get" action="/preview/${l.id}"><button title="See the exact email that will be sent to this lead">👁 Preview</button></form>
          <form method="post" action="/action/${l.id}/send" onsubmit="return confirm('Send the next email in the sequence to this lead now?')"><button class="send" title="Send the next email (initial → FU1 → FU2) to THIS lead now. Respects DRY_RUN.">✉ Send</button></form>
          <form method="post" action="/action/${l.id}/block"><button title="Move to Block List — never contacted again, removed from sending & future sourcing">⛔ Block</button></form>
          <form method="post" action="/action/${l.id}/delete" onsubmit="return confirm('Delete this lead permanently? (Block is better for junk — it also prevents re-sourcing.)')"><button title="Delete this lead permanently from the database">🗑</button></form>
        </td>
      </tr>`).join('');

      const mode = dry
        ? '<span class="pill dry">DRY RUN · nothing is sent</span>'
        : '<span class="pill live">LIVE · sending real email</span>';
      const dryToggle = `<form method="post" action="/drymode" onsubmit="return confirm(${dry
        ? "'Go LIVE? Real emails will be sent according to the send mode below.'"
        : "'Switch back to DRY RUN? No further emails will be sent.'"})"><input type="hidden" name="value" value="${dry ? 'false' : 'true'}"><button class="${dry ? 'primary' : ''}" title="Switch between DRY RUN (safe, simulates only) and LIVE (sends real email). Controlled entirely from here — no Railway needed.">${dry ? '🚀 Go LIVE' : '🧪 Back to DRY'}</button></form>`;
      const PILLS = {
        paused: '<span class="pill paused">PAUSED</span>',
        manual: '<span class="pill manual">MANUAL send</span>',
        auto: '<span class="pill auto">AUTO send</span>'
      };
      const sendPill = PILLS[sendMode] || PILLS.manual;
      const gmailPill = gmailConnected
        ? '<span class="pill auto">Gmail ✓</span>'
        : '<span class="pill err">Gmail not connected</span>';
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
          ${mode} ${sendPill} ${gmailPill} ${dryToggle}
          <div class="toolbar">
            <form method="post" action="/run/refill"><button class="primary" title="Fetch new utility-app studios from AppStoreSpy using the search criteria below, screen them, and add them as leads">Source now</button></form>
            <form method="post" action="/run/send"><button title="Send one paced batch now to leads in the queue — respects the daily quota, the send window, and DRY/LIVE mode">Send tick</button></form>
            <form method="post" action="/run/watch"><button title="Scan the inbox now for replies and bounces and update lead statuses">Check replies</button></form>
            <span class="seg">${modeCtl}</span>
            <form method="post" action="/test-email"><button title="Send a test email to your own inbox to verify Gmail works (bypasses DRY, only emails you)">✉ Test to me</button></form>
            <form method="get" action="/duplicates"><button title="Review & merge duplicate leads (same email) — combine their apps into one">🔁 Duplicates</button></form>
            ${blankNameCount ? `<form method="post" action="/admin/fix-names" onsubmit="return confirm('Fix ${blankNameCount} lead(s) with a blank Studio name?')"><button class="primary" title="AppStoreSpy returned no developer name for these — fill in the app name or developer ID instead of leaving it blank">🩹 Fix ${blankNameCount} blank name${blankNameCount === 1 ? '' : 's'}</button></form>` : ''}
            ${cov.needs_enrich ? `<form method="post" action="/admin/enrich"><input type="hidden" name="batch" value="50"><button title="Read up to 50 studio websites for a founder name and a LinkedIn link. Free - no API credits - but takes a minute.">🔎 Find people (${cov.needs_enrich})</button></form>` : ''}
            <form method="get" action="/audit"><button title="Find possibly-irrelevant leads (giants, junk) to review and block">🔎 Audit</button></form>
            <form method="get" action="/reviews"><button title="See the actual review quotes behind every 💬 buy-signal badge">💬 Reviews</button></form>
            <form method="post" action="/admin/clear" onsubmit="return confirm('Delete ALL leads and events? This cannot be undone.')"><button title="Delete all leads to start fresh">🗑 Clear</button></form>
          </div>
        </header>

        ${msg ? `<div class="banner">${msg}</div>` : ''}

        ${st.replied ? `<div class="banner" style="border-color:#10b981;background:#dcfce7;color:#065f46">
          🎉 <b>${st.replied} lead${st.replied === 1 ? '' : 's'} replied to your email.</b>
          <a href="/?view=replied" style="margin-left:.5rem;font-weight:600">Show them →</a>
          <span style="opacity:.8">Set “Booked a call” or “Not Relevant” on the row once you have read them.</span>
          ${leads.filter((l) => l.response === R.respond && l.reply_snippet).slice(0, 5).map((l) => `
            <div style="margin-top:.5rem;padding:.5rem .7rem;background:#ffffff88;border-radius:8px">
              <b>${esc(l.name)}</b>${l.reply_subject ? ` <span style="opacity:.7">— ${esc(l.reply_subject)}</span>` : ''}
              <a href="/reply/${l.id}" style="margin-left:.4rem;font-weight:600">✍️ Draft a reply →</a>
              ${l.reply_thread ? `<a href="https://mail.google.com/mail/u/0/#inbox/${esc(l.reply_thread)}" target="_blank" rel="noopener" style="margin-left:.4rem">open in Gmail →</a>` : ''}
              <div style="opacity:.85;font-style:italic;margin-top:.2rem">“${esc(l.reply_snippet)}”</div>
            </div>`).join('')}
        </div>` : ''}

        ${!gmailConnected ? `<div class="banner">📧 <b>Gmail is not connected</b> — no email can be sent until you connect it.
          ${config.google.clientId
            ? '<form method="get" action="/oauth/start" style="display:inline;margin-left:.5rem"><button class="primary">🔗 Connect Gmail</button></form>'
            : ' Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Railway first (see setup).'}
          <div style="font-size:.8rem;margin-top:.4rem;opacity:.85">In Google Cloud, register this exact Authorized redirect URI: <code>${esc(redirectUri)}</code></div>
        </div>` : ''}

        <div class="status">
          <span>Window: <b>${wOpen ? 'OPEN' : 'closed'}</b> (${config.sender.windowStartHour}:00–${config.sender.windowEndHour}:00, Mon–Fri)</span>
          <span>Sent today: <b>${sentToday}</b> /
            <form method="post" action="/quota" style="display:inline-flex;align-items:center;gap:.3rem" title="Set a fixed number of emails to send per day. Leave empty/0 to use the automatic warm-up ramp (currently ${quota}/day).">
              <input name="value" value="${crit.dailyQuotaOverride || ''}" placeholder="${quota}" style="width:55px;padding:.15rem .3rem">
              <button style="padding:.15rem .5rem" title="Save this as the fixed daily email quota (0 = automatic ramp)">Set</button>
            </form>
          </span>
          <span>Duplicates: <b>${dupCount}</b>${dupCount ? ' (click 🔁 Dedupe)' : ''}</span>
          <span id="nexttick" data-mode="${sendMode}" data-dry="${dry ? '1' : '0'}">…</span>
          <span id="replytick" data-last="${esc(lastWatchRun)}" title="${esc(lastWatchStatus)}">…</span>
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
            <label style="display:block;font-size:.8rem;color:var(--muted)">Categories (comma-separated Google Play APP categories)
              <input name="categories" value="${esc(crit.categories.join(','))}" style="width:100%;margin-top:.2rem"></label>
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
            <label style="display:flex;align-items:center;gap:.4rem;margin:.4rem 0">
              <input type="checkbox" name="scanReviews" ${crit.scanReviews ? 'checked' : ''}>
              Mine reviews for buy-signals (“too expensive”, “should be free”…) — boosts Opportunity, uses more API credits
            </label>
            <label style="display:flex;align-items:center;gap:.4rem;margin:.4rem 0">
              <input type="checkbox" name="enrichFromSite" ${crit.enrichFromSite ? 'checked' : ''}>
              Read each studio’s own website for the founder’s name and LinkedIn — free (no API credits), but makes sourcing slower
            </label>
            <button class="primary" title="Save these search criteria to the database; they take effect on the next “Source now” and scheduled refill">Save criteria</button>
            <span class="muted" style="font-size:.78rem">Valid: ${criteria.VALID_CATEGORIES.join(', ')}</span>
          </form>
        </details>

        <form id="bulkform" method="post" action="/bulk"></form>
        <div class="bar" style="margin:.4rem 0">
          <label title="Check/uncheck every row currently shown (respects the active filters)"><input type="checkbox" onclick="document.querySelectorAll('.rowchk').forEach(function(c){c.checked=this.checked}.bind(this))"> Select all shown</label>
          <button form="bulkform" name="action" value="block" onclick="return confirm('Block the selected leads?')" title="Move every checked row to the Block List — never contacted again">⛔ Block selected</button>
          <button form="bulkform" name="action" value="delete" onclick="return confirm('Delete the selected leads permanently?')" title="Permanently delete every checked row">🗑 Delete selected</button>
        </div>
        <form method="get" action="/" id="filterform" style="margin:.4rem 0">
          <div class="bar">
            <label title="Quick presets: which leads to show based on their group/status">View:
              <select name="view" onchange="this.form.submit()" title="Quick presets: which leads to show based on their group/status">
                ${[['nonblocked', 'Hide blocked'], ['all', 'All'], ['queue', 'Queue (not contacted)'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['blocked', 'Blocked only']]
                  .map(([v, l]) => `<option value="${v}"${view === v ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
            </label>
            <input name="q" value="${esc(f.q)}" placeholder="Search studio, app, category, email…" style="width:220px" title="Free-text search across Studio, App name, Category, and Email">
            <label title="Filter to only Android or only iOS leads">OS: <select name="platform" onchange="this.form.submit()" title="Filter to only Android or only iOS leads">
              <option value=""${!f.platform ? ' selected' : ''}>All</option>
              <option value="android"${f.platform === 'android' ? ' selected' : ''}>🤖 Android</option>
              <option value="ios"${f.platform === 'ios' ? ' selected' : ''}>🍎 iOS</option>
            </select></label>
            <button type="submit" title="Apply the search box + OS filter above">Apply filters</button>
            ${anyFilterActive ? '<a href="/" title="Remove every active filter and show the default view">Clear filters</a>' : ''}
            <span class="muted">Showing ${shown.length} of ${leads.length} leads</span>
          </div>
          <details class="crit" style="margin-top:.4rem">
            <summary>🎛 More column filters (Opportunity, Installs, Rating, Revenue, Apps, Priority, Outreach/Response)</summary>
            <div class="grid" style="margin-top:.6rem">
              <label title="Only show leads with an Opportunity Score at or above this (0–100)">Opportunity min<input name="f_oppMin" value="${esc(f.oppMin || '')}"></label>
              <label title="Only show leads with an Opportunity Score at or below this (0–100)">Opportunity max<input name="f_oppMax" value="${esc(f.oppMax || '')}"></label>
              <label title="Only show apps with at least this many all-time installs">Total installs min<input name="f_instMin" value="${esc(f.instMin || '')}"></label>
              <label title="Only show apps with at most this many all-time installs">Total installs max<input name="f_instMax" value="${esc(f.instMax || '')}"></label>
              <label title="Only show apps rated at or above this (0–5)">Rating min<input name="f_ratingMin" value="${esc(f.ratingMin || '')}"></label>
              <label title="Only show leads earning at most this much per month — filters out already well-monetized apps">Revenue/mo max ($)<input name="f_revMax" value="${esc(f.revMax || '')}"></label>
              <label title="Only show developers with at least this many published apps">Apps count min<input name="f_appsMin" value="${esc(f.appsMin || '')}"></label>
              <label title="Only show developers with at most this many published apps — filters out giant app-farms">Apps count max<input name="f_appsMax" value="${esc(f.appsMax || '')}"></label>
              <label title="Only show leads with Priority at or below this — filters out giants like Google/Samsung">Priority max<input name="f_prioMax" value="${esc(f.prioMax || '')}"></label>
              <label title="Only show leads currently at this stage of the send sequence">Outreach status<select name="f_outreach">
                <option value=""${!f.outreach ? ' selected' : ''}>Any</option>
                ${OUTREACH_OPTS.filter(Boolean).map((o) => `<option value="${esc(o)}"${o === f.outreach ? ' selected' : ''}>${esc(o)}</option>`).join('')}
              </select></label>
              <label title="Only show leads with this Response status">Response status<select name="f_response">
                <option value=""${!f.response ? ' selected' : ''}>Any</option>
                ${RESPONSE_OPTS.filter(Boolean).map((o) => `<option value="${esc(o)}"${o === f.response ? ' selected' : ''}>${esc(o)}</option>`).join('')}
              </select></label>
            </div>
            <p><button type="submit" title="Apply all the column filters above">Apply filters</button></p>
          </details>
        </form>
        <details class="crit" style="margin:.4rem 0">
          <summary>ℹ️ What do these columns &amp; filters mean? (tap to open — works on phones too)</summary>
          <div style="margin-top:.6rem;font-size:.85rem;line-height:1.7">
            <b>Opp (Opportunity Score, 0–100):</b> how good an acquisition target this app is — high demand (rating, reviews, installs) combined with weak monetization (low/no revenue, no ads/IAP) and signs it's cheap to buy (solo dev, no website, few apps). Higher is better. This is what the list is sorted by.<br>
            <b>Priority:</b> installs/day × total apps published by this developer. It is a raw "how big is this developer" number, used only as a tie-breaker after Opportunity — a high Priority is <i>not</i> a good sign by itself (Google/Samsung score millions here); use "Priority max" in filters to hide giants.<br>
            <b>Total inst / Inst/day:</b> all-time installs of this specific app, and the developer's current daily install velocity (still-alive demand).<br>
            <b>Rev/mo, $/inst:</b> the app's estimated monthly revenue, and revenue per install (low = weak monetization = upside).<br>
            <b>💬 badge:</b> number of reviews found complaining about price/ads or offering to pay — open <b>👁 Preview</b> on that lead to read the actual quotes.<br>
            <b>Site:</b> 🌐 is the studio's own website. It comes from Google Play when listed; otherwise it is inferred from the privacy-policy link or the email domain. A dash means we found nothing, which is itself a solo-dev signal (the score only counts a website Google Play actually listed).<br>
            <b>Contact:</b> the person behind the app. <b>✅</b> means the name was read off the studio's own website and is reliable. <b>~</b> means it was split out of the email address (jane.doe@… → Jane Doe) and is a <i>guess</i> — never address someone by a ~ name without checking. Outreach emails deliberately keep using the studio name.<br>
            <b>Country:</b> where the studio is based, from AppStoreSpy. Its job is to narrow down a common name on LinkedIn.<br>
            <b>Contact coverage right now:</b> ${cov.total} lead${cov.total === 1 ? '' : 's'} —
            ${cov.with_site} with a website, ${cov.with_name} with a contact name
            (${cov.name_verified} of those verified from the studio site),
            ${cov.with_linkedin} with a LinkedIn URL, ${cov.with_country} with a country.
            Check these numbers before paying for external enrichment: if the free steps already cover most leads, there is nothing to buy.<br>
            <b>Find:</b> opens ready-made LinkedIn <i>searches</i> for this lead — by name + studio, by name + country, by app name (developers often list their own app in their profile), and by studio + role. These are searches, not verified profiles: you pick the right person. <b>in ✅</b> appears instead when the studio published its own LinkedIn link, which is the one case where the profile is known rather than guessed.<br>
            <b>View:</b> quick presets (e.g. "Queue" = never contacted yet). <b>Search:</b> matches Studio/App/Category/Email. <b>OS:</b> Android vs iOS (only Android is sourced today).<br>
            <b>More column filters:</b> set any combination of numeric ranges/statuses above and click Apply — they combine with View and Search.
          </div>
        </details>
        <p class="legend">The <b>Studio</b> and <b>Actions</b> columns stay pinned; scroll the table sideways for status &amp; details.</p>
        <div class="card wrap"><table>
          <thead><tr>
            <th>Studio</th><th>App</th><th title="🤖 Android or 🍎 iOS">OS</th><th title="Acquisition Opportunity Score (0–100): demand × weak monetization × how cheap/easy to acquire. Sorted high to low.">Opp</th><th>Category</th>
            <th title="Developer's current installs/day (install velocity)">Inst/day</th><th title="This app's all-time installs">Total inst</th>
            <th title="Number of apps this developer has published">Apps</th><th title="This app's estimated revenue per month">Rev/mo</th><th title="Revenue per install — low means weak monetization (upside for acquisition)">$/inst</th>
            <th title="This app's Google Play rating (0–5) and number of ratings">Rating</th>
            <th title="Installs/day × total apps for this developer. A raw 'how big' number, NOT a quality signal — Google/Samsung score in the billions here. Used only to break ties after Opportunity; filter it out with 'Priority max'.">Priority</th>
            <th>Email</th><th>Store</th><th title="The studio's own website, when Google Play lists one. Blank is itself a signal — solo devs often have none.">Site</th>
            <th title="The person behind the app. ✅ was read off the studio's own site; ~ was guessed from the email address and is unverified.">Contact</th>
            <th title="Where the studio is based (AppStoreSpy hq_country). Narrows down a common name on LinkedIn.">Country</th>
            <th title="Opens ready-made LinkedIn searches for this lead — by name, by studio, and by app name. These are searches, not verified profiles: you pick the right person.">Find</th>
            <th>Outreach status</th><th>Response status</th><th title="What the lead actually wrote back (hover for more, or open the thread in Gmail)">Reply</th><th>Group</th><th></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="21" class="muted">No leads yet — click “Source now”.</td></tr>'}</tbody>
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
        </p>
        <p class="legend">${dry
          ? '🧪 <b>DRY RUN is ON — no email leaves the building.</b> Every send button only simulates and logs what it would do. Click <b>🚀 Go LIVE</b> (top-left) when you want real sends.'
          : `🔴 <b>LIVE — real emails are really being sent.</b> ${sendMode === 'auto'
              ? 'The scheduler is sending on its own every 15 min inside the send window.'
              : sendMode === 'paused'
                ? 'Sending is currently PAUSED, so nothing goes out until you switch to Manual or Auto.'
                : 'You are in Manual mode, so mail goes out only when you click ✉ Send or Send tick.'} Switch to <b>🧪 Back to DRY</b> to stop.`}
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
        (function(){
          var el=document.getElementById('replytick'); if(!el) return;
          var lastIso=el.getAttribute('data-last');
          function pad(n){return (n<10?'0':'')+n;}
          function tick(){
            var d=new Date(), into=(d.getMinutes()%30)*60+d.getSeconds(), left=1800-into; if(left<=0)left=1800;
            var m=Math.floor(left/60), s=left%60, cd=pad(m)+':'+pad(s);
            var agoTxt='never run yet';
            if(lastIso){
              var ms=d.getTime()-new Date(lastIso).getTime();
              var mins=Math.floor(ms/60000);
              agoTxt = mins<1 ? 'just now' : (mins<60 ? (mins+'m ago') : (Math.floor(mins/60)+'h '+(mins%60)+'m ago'));
            }
            el.textContent='📥 Last reply check: '+agoTxt+' · next in '+cd+' (every 30m)';
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
      const dry = await liveMode.isDry();
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
        ${Number(lead.review_signals) ? `<div class="card" style="padding:1rem;max-width:760px;margin-top:1rem"><b>💬 Buy-signals found in reviews (${lead.review_signals}):</b><br><span class="muted">${esc(lead.review_evidence)}</span></div>` : ''}

        <div class="card" style="padding:1rem;max-width:760px;margin-top:1rem">
          <b>🧑 Who is behind this app?</b>
          <div style="margin-top:.5rem;line-height:1.8">
            <div><b>Studio:</b> ${esc(lead.name)}${lead.country ? ` <span class="muted">(${esc(lead.country)})</span>` : ''}</div>
            <div><b>Contact name:</b> ${lead.contact_name
              ? `${esc(lead.contact_name)} ${lead.contact_name_source === 'site'
                  ? '<span style="color:#059669">✅ read from their website</span>'
                  : '<span style="color:#b45309">~ guessed from the email address, unverified</span>'}`
              : '<span class="muted">not found</span>'}</div>
            <div><b>Website:</b> ${lead.website ? `<a href="${esc(lead.website)}" target="_blank" rel="noopener">${esc(lead.website)}</a>` : '<span class="muted">none</span>'}</div>
            <div><b>LinkedIn:</b> ${lead.linkedin_url
              ? `<a href="${esc(lead.linkedin_url)}" target="_blank" rel="noopener">${esc(lead.linkedin_url)}</a>`
              : '<span class="muted">not resolved - use a search below</span>'}</div>
          </div>
          ${(() => {
            const searches = people.linkedinSearches({
              contactName: lead.contact_name, studio: lead.name, appName: lead.top_app, country: lead.country
            });
            if (!searches.length) return '';
            return `<div style="margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--line)">
              <div class="muted" style="font-size:.8rem;margin-bottom:.3rem">Search LinkedIn - each angle finds a different kind of match, and you decide which hit is the right person:</div>
              ${searches.map((s) => `<div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a> <span class="muted" style="font-size:.78rem">- ${esc(s.why)}</span></div>`).join('')}
            </div>`;
          })()}
          <div style="margin-top:.7rem">
            <form method="post" action="/action/${lead.id}/linkedin">
              <button title="Look the profile up automatically through Apify (searches Google's index of public LinkedIn profiles). Costs money per lookup, so use it on leads you actually intend to contact.">🔗 Look up LinkedIn automatically</button>
            </form>
          </div>
        </div>
        <p style="margin-top:1rem">
          <form method="post" action="/action/${lead.id}/send" onsubmit="return confirm('Send this email now?')"><button class="send" title="Send this exact email now (respects DRY/LIVE mode)">✉ Send this now</button></form>
          <a href="/" style="margin-left:.6rem">Cancel</a>
        </p>
        <p class="legend">This is exactly what the recipient will receive${dry ? ' — but DRY RUN is on, so “Send this now” only simulates.' : '.'}</p>
      `));
    } catch (e) { res.status(500).send('Error: ' + esc(e.message)); }
  });

  // Manual per-lead send: sends the next email in the sequence to one lead.
  app.post('/action/:id/send', async (req, res) => {
    try {
      const r = await sendOne(Number(req.params.id));
      if (r.error) return back(res, '⚠️ Not sent — ' + r.error);
      if (r.dry) return back(res, 'DRY RUN — would send the ' + r.step + ' email now. Click 🚀 Go LIVE (top-left) to actually send.');
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
  // Draft an answer to a reply. The angle is chosen from what they actually
  // wrote, but nothing is sent until a human has read and edited it.
  app.get('/reply/:id', async (req, res) => {
    try {
      const r = await db.q('SELECT * FROM leads WHERE id = $1', [req.params.id]);
      const lead = r.rows[0];
      if (!lead) return res.status(404).send('Lead not found');

      const chosen = String(req.query.intent || '');
      const instruction = String(req.query.instruction || '');
      const wantAI = req.query.ai !== 'off';

      // Read the real conversation from Gmail. The watcher only stores a
      // 500-char snippet, which is not enough to answer a long reply properly.
      let thread = [];
      if (lead.reply_thread || lead.thread_id) {
        try { thread = await email.fetchThread(lead.reply_thread || lead.thread_id); }
        catch (e) { thread = []; }
      }

      const d = await replydraft.draftSmart({
        lead, thread, intentOverride: chosen, instruction, useAI: wantAI
      });
      const aiOn = await ai.isEnabled();
      const dry = await liveMode.isDry();
      const guard = screenReason({ name: lead.name, email: lead.email, notes: lead.notes, topApp: lead.top_app });

      const options = replydraft.intents().map((i) =>
        `<option value="${esc(i.intent)}" ${i.intent === d.intent ? 'selected' : ''}>${esc(i.label)}</option>`).join('');

      res.send(shell(`
        <p><a href="/">← Back to list</a></p>
        <h1 style="font-size:1.2rem">Reply to ${esc(lead.name)}</h1>

        <div class="card" style="padding:1rem;max-width:820px">
          <b>💬 What they wrote</b>
          ${lead.reply_subject ? `<div class="muted" style="margin-top:.3rem">${esc(lead.reply_subject)}</div>` : ''}
          <div style="margin-top:.5rem;padding:.7rem;background:var(--surface-2,#f1f5f9);border-radius:6px;line-height:1.6;max-height:340px;overflow:auto">
            ${thread.length
              ? thread.filter((m) => !m.fromUs).slice(-2).map((m) =>
                  `<div style="white-space:pre-wrap">${esc(m.text)}</div>`).join('<hr style="border:none;border-top:1px solid var(--line);margin:.6rem 0">')
              : (lead.reply_snippet
                ? `<span style="font-style:italic">${esc(lead.reply_snippet)}</span>`
                : '<span class="muted">Nothing was captured. Open the thread in Gmail and read it there.</span>')}
          </div>
          ${lead.reply_thread ? `<div style="margin-top:.5rem"><a href="https://mail.google.com/mail/u/0/#inbox/${esc(lead.reply_thread)}" target="_blank" rel="noopener">Open the full thread in Gmail →</a>
            </div>` : ''}
        </div>

        <form method="get" action="/reply/${lead.id}" class="card stack" style="padding:1rem;max-width:820px;margin-top:1rem">
          <b>🎯 How this was written</b>
          <div class="muted" style="font-size:.85rem;margin:.3rem 0 .6rem">
            ${d.source === 'ai'
              ? `<span style="color:#059669;font-weight:600">✨ Claude wrote this</span> for their actual message.
                 Read as: <b>${esc(d.label)}</b>${d.why ? ' - ' + esc(d.why) : ''}`
              : `<span style="color:#b45309;font-weight:600">📋 Template</span> - matched by keyword as
                 <b>${esc(d.label)}</b>${d.why ? ' (' + esc(d.why) + ')' : ''}.
                 ${d.aiError ? `Claude was not used: ${esc(d.aiError)}.` : ''}
                 ${!aiOn ? 'Set <code>ANTHROPIC_API_KEY</code> in Railway to get replies written for each message.' : ''}`}
            <br>${d.pushesForMeeting
              ? 'It asks for a call, and offers the numbers as the way out if they would rather not meet.'
              : 'It deliberately does not push for a meeting.'}
            ${thread.length
              ? `<br>Based on the <b>full thread</b> (${thread.length} message${thread.length === 1 ? '' : 's'}) read from Gmail.`
              : '<br>⚠️ Could not read the full thread from Gmail - working from the captured snippet only.'}
          </div>
          <label style="display:block;font-size:.8rem;color:var(--muted)">Tell Claude what to do differently (optional)
            <input name="instruction" value="${esc(instruction)}" placeholder="e.g. they said email only - do not ask for a call, and mention the NDA"
                   style="width:100%;margin-top:.2rem">
          </label>
          <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.6rem">
            <select name="intent"><option value="">Let Claude decide the angle</option>${options}</select>
            <button class="primary">${d.source === 'ai' ? '✨ Rewrite' : '✨ Try Claude'}</button>
            <button name="ai" value="off" title="Skip Claude and use the keyword-matched template">Use template instead</button>
          </div>
        </form>

        <form method="post" action="/reply/${lead.id}/send" class="card stack" style="padding:1rem;max-width:820px;margin-top:1rem"
              onsubmit="return confirm('Send this reply to ${esc(lead.email)}?')">
          <b>✍️ Your reply</b>
          <div class="muted" style="font-size:.8rem;margin:.3rem 0 .6rem">
            To ${esc(lead.email)} - goes into the same Gmail thread. Write it as a normal email;
            bullet lines starting with <code>-</code> or <code>1.</code> become proper lists.
          </div>
          <label style="display:block;font-size:.8rem;color:var(--muted)">Subject
            <input name="subject" value="${esc(d.subject)}" style="width:100%;margin-top:.2rem">
          </label>
          <textarea name="text" rows="24" spellcheck="true"
            style="width:100%;margin-top:.7rem;padding:.7rem;border:1px solid var(--line);border-radius:8px;
                   background:var(--bg);color:var(--ink);font:inherit;line-height:1.6;resize:vertical"
          >${esc(d.text)}</textarea>
          ${guard ? `<div class="banner" style="margin:.6rem 0">⚠️ This lead trips a guard: <b>${esc(guard)}</b>. Sending is blocked.</div>` : ''}
          <div style="margin-top:.7rem;display:flex;gap:.6rem;align-items:center">
            <button class="send" ${guard ? 'disabled' : ''}>✉ Send reply${dry ? ' (dry run - nothing will leave)' : ''}</button>
            <a href="/">Cancel</a>
          </div>
        </form>
      `));
    } catch (e) { return back(res, '⚠️ Could not draft a reply: ' + e.message); }
  });

  app.post('/reply/:id/send', async (req, res) => {
    try {
      const r = await db.q('SELECT * FROM leads WHERE id = $1', [req.params.id]);
      const lead = r.rows[0];
      if (!lead) return back(res, '⚠️ Lead not found.');
      if (!lead.email) return back(res, '⚠️ That lead has no email address.');

      const guard = screenReason({ name: lead.name, email: lead.email, notes: lead.notes, topApp: lead.top_app });
      if (guard) return back(res, `⚠️ Not sent - this lead trips a guard: ${guard}`);

      // The operator writes plain text; it becomes email HTML here.
      const text = String(req.body.text || '').trim();
      if (!text) return back(res, '⚠️ Not sent - the reply was empty.');
      const html = replydraft.textToHtml(text);
      const subject = String(req.body.subject || '').trim() || ('Re: ' + lead.name);

      if (await liveMode.isDry()) {
        return back(res, `🧪 Dry run - nothing was sent. In LIVE this would reply to ${lead.email} in the existing thread.`);
      }

      await email.send({
        to: lead.email, subject, html,
        inReplyTo: lead.message_id || undefined,
        threadId: lead.reply_thread || lead.thread_id || undefined
      });
      await db.logEvent(lead.id, 'reply_sent');
      return back(res, `✉ Replied to ${lead.name} <${lead.email}> in the same thread.`);
    } catch (e) { return back(res, '⚠️ Reply failed: ' + e.message); }
  });

  app.post('/criteria', async (req, res) => {
    try {
      // checkboxes: an unticked box is absent from the body entirely
      req.body.scanReviews = req.body.scanReviews ? 'true' : 'false';
      req.body.enrichFromSite = req.body.enrichFromSite ? 'true' : 'false';
      await criteria.set(req.body || {});
    } catch (e) { console.error('[criteria]', e.message); }
    res.redirect('/');
  });
  app.post('/quota', async (req, res) => {
    try {
      const n = Number(req.body.value);
      await criteria.set({ dailyQuotaOverride: Number.isFinite(n) && n > 0 ? n : 0 });
      return back(res, n > 0 ? `Daily send quota set to ${n}/day.` : 'Daily send quota reset to the automatic warm-up ramp.');
    } catch (e) { return back(res, '⚠️ Could not set quota: ' + e.message); }
  });
  app.post('/mode', async (req, res) => {
    const v = ['paused', 'manual', 'auto'].includes(req.body.value) ? req.body.value : 'manual';
    await db.setSetting('send_mode', v);
    const label = { paused: '⏸ Sending PAUSED — no automatic messages go out.', manual: '✋ Manual mode — you send per lead or with Send tick.', auto: '▶ Auto mode — the scheduler will send automatically.' };
    return back(res, label[v]);
  });
  // Dashboard-controlled DRY RUN <-> LIVE switch (no Railway visit needed).
  app.post('/drymode', async (req, res) => {
    const goLive = req.body.value === 'false';
    await liveMode.setDry(!goLive);
    return back(res, goLive
      ? '🚀 LIVE — real email will now be sent (per the send mode below).'
      : '🧪 Back to DRY RUN — nothing will be sent.');
  });
  app.post('/admin/clear', async (req, res) => {
    try { await db.clearLeads(); return back(res, 'All leads cleared.'); }
    catch (e) { return back(res, '⚠️ Clear failed: ' + e.message); }
  });
  app.post('/admin/dedupe', async (req, res) => {
    try { const n = await db.removeDuplicates(); return back(res, `🔁 Removed ${n} duplicate lead${n === 1 ? '' : 's'} (kept one per email).`); }
    catch (e) { return back(res, '⚠️ Dedupe failed: ' + e.message); }
  });
  app.post('/admin/fix-names', async (req, res) => {
    try { const n = await db.backfillBlankNames(); return back(res, `🩹 Fixed ${n} lead(s) with a blank Studio name (used the app name or developer ID instead).`); }
    catch (e) { return back(res, '⚠️ Fix names failed: ' + e.message); }
  });

  // Read studio websites for leads we already have. Runs in the background and
  // reports through the banner, because a batch of sites takes minutes and an
  // HTTP request that hangs that long just times out in the browser.
  app.post('/admin/enrich', async (req, res) => {
    const batch = Math.max(1, Math.min(500, Number(req.body.batch) || 50));
    let rows;
    try { rows = await db.leadsNeedingEnrichment(batch, 30); }
    catch (e) { return back(res, '⚠️ Enrich failed: ' + e.message); }
    if (!rows.length) return back(res, 'Nothing to enrich - every lead with a website already has a contact name and LinkedIn.');

    (async () => {
      let named = 0, linked = 0;
      for (const row of rows) {
        try {
          const found = await enrich.enrichFromSite(row.website);
          const fields = { site_checked_at: new Date().toISOString().slice(0, 10) };
          // Only overwrite a guessed name - a name read off the site outranks one
          // split out of an email, but never clobber something already verified.
          if (found.contactName && row.contact_name !== found.contactName) {
            fields.contact_name = found.contactName;
            fields.contact_name_source = 'site';
            named++;
          }
          if (found.linkedin && !row.linkedin_url) { fields.linkedin_url = found.linkedin; linked++; }
          await db.updateLead(row.id, fields);
        } catch (e) { /* one bad site must not stop the batch */ }
      }
      console.log(`[enrich] backfill done: ${rows.length} sites read, ${named} names, ${linked} LinkedIn URLs`);
    })().catch((e) => console.error('[enrich] backfill crashed', e));

    return back(res, `🔎 Reading ${rows.length} studio website${rows.length === 1 ? '' : 's'} in the background. Refresh in a minute to see names and LinkedIn links appear.`);
  });

  // Paid LinkedIn lookup for one shortlisted lead (Apify + Google index).
  app.post('/action/:id/linkedin', async (req, res) => {
    try {
      const r = await db.q('SELECT * FROM leads WHERE id = $1', [req.params.id]);
      const lead = r.rows[0];
      if (!lead) return back(res, '⚠️ Lead not found.');

      const out = await apify.findProfiles(lead);
      if (out.skipped) return back(res, `⚠️ LinkedIn lookup skipped: ${out.skipped}`);
      if (!out.candidates.length) return back(res, `No LinkedIn profile found for ${lead.name}. Try the 🔍 Find searches by hand.`);

      const best = out.candidates[0];
      await db.updateLead(lead.id, { linkedin_url: best.url });
      const others = out.candidates.length - 1;
      return back(res, `🔗 Best match for ${lead.name}: ${best.url}${others ? ` (${others} other candidate${others === 1 ? '' : 's'} found - check it is the right person)` : ''}`);
    } catch (e) { return back(res, '⚠️ LinkedIn lookup failed: ' + e.message); }
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

  // Dedicated, always-visible list of the actual review quotes behind the
  // 💬 badge — no hovering required (title tooltips don't work on touch).
  app.get('/reviews', async (req, res) => {
    try {
      const leads = (await db.allLeads()).filter((l) => Number(l.review_signals) > 0);
      if (!leads.length) return res.send(shell('<p><a href="/">← Back to list</a></p><div class="banner">No review-based buy-signals found yet. Run “Source now” with “Mine reviews” enabled in Search criteria.</div>'));
      const rows = leads.map((l) => `<tr>
        <td><b>${esc(l.name)}</b></td>
        <td>${l.store_link ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">${esc(l.top_app)}</a>` : esc(l.top_app)}</td>
        <td class="num">${num(l.review_signals)}</td>
        <td class="num"><b>${num(l.opportunity)}</b></td>
        <td style="white-space:normal;max-width:420px">${esc(l.review_evidence)}</td>
        <td style="white-space:nowrap"><a href="/preview/${l.id}">👁 Preview</a></td>
      </tr>`).join('');
      res.send(shell(`<p><a href="/">← Back to list</a></p>
        <h1 style="font-size:1.2rem">💬 Review evidence (${leads.length} leads)</h1>
        <p class="legend">The actual review quotes the Opportunity Score's buy-signal boost is based on — sorted by Opportunity. Each row is a real excerpt found in that app's reviews on Google Play.</p>
        <div class="card wrap"><table><thead><tr><th>Studio</th><th>App</th><th># signals</th><th>Opp</th><th>Review quotes found</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`));
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
    const dry = await liveMode.isDry();
    runSender({ scheduled: false }).catch((e) => console.error(e));
    return back(res, dry
      ? 'Send tick ran in DRY RUN — nothing sent (see logs). Click 🚀 Go LIVE to send for real.'
      : 'Send tick triggered — sending a batch now; refresh to see the counters move.');
  });
  app.post('/run/watch', (req, res) => {
    runReplyWatcher().catch((e) => console.error(e));
    back(res, 'Reply/bounce check started.');
  });

  return app;
}

module.exports = { makeApp };
