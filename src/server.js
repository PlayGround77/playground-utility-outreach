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
/** "3h ago" / "2d ago" — a message's age matters more than its exact timestamp. */
function agoLabel(iso) {
  const t = Date.parse(String(iso || ''));
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return mins <= 1 ? 'just now' : mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * A same-origin path+query, safe to redirect to. Rejects anything that could
 * send the browser off-site (a bare "//evil.com" or "\\evil.com" both parse as
 * protocol-relative in some browsers) - this only ever carries our own "come
 * back to this filtered view" URL, never a value we'd want to leave unchecked.
 */
function safeBack(v) {
  const s = String(v || '');
  return /^\/(?!\/|\\)\S*$/.test(s) ? s : '';
}
/** Where a POST/GET should return to: the "back" it was sent, or the list. */
function backUrl(req) {
  return safeBack(req.body && req.body.back) || safeBack(req.query && req.query.back) || '/';
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

// Only ever a number the studio published AS a phone number - a tel: link, a
// labelled line on their site, or the store's developer contact. There is no
// digit-scraping fallback: a page is full of digit runs (VAT and company
// numbers, dates, postcodes), and a wrong number here means cold-calling a
// stranger. Their own formatting is kept; only the tel: link is normalised.
function phoneCell(l) {
  const shown = String(l.phone || '');
  if (!shown) {
    return '<span class="muted" title="No phone published. Only a tel: link, a Phone:/Tel: line on their site, or the store listing counts - nothing is guessed from digits on the page.">—</span>';
  }
  const dial = people.normalisePhone(shown);
  const why = {
    tel: 'A tap-to-call link on the studio\'s own website',
    text: 'Listed on their site behind a Phone/Tel label',
    store: 'The developer contact on the store listing'
  }[l.phone_source] || 'Published by the studio';
  return `<a href="tel:${esc(dial)}" title="${esc(why)}" style="white-space:nowrap">📞 ${esc(shown)}</a>`;
}

// The LinkedIn wordmark, inline so it needs no external asset and inherits the
// surrounding colour: brand blue when we have a real profile, muted when the
// links below it are only searches.
function liIcon(size) {
  const s = size || 16;
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" aria-hidden="true" focusable="false" style="vertical-align:-.15em">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/>
  </svg>`;
}

// A profile the studio published on its own site is a real link. Everything
// else is a set of searches, and is shown as such - a search dressed up as a
// profile link is how you end up emailing the wrong person.
function findPersonCell(l) {
  if (l.linkedin_url) {
    const isCompany = /\/company\//i.test(l.linkedin_url);
    return `<a class="li li-on" href="${esc(l.linkedin_url)}" target="_blank" rel="noopener"
      title="${isCompany ? 'Company page' : 'Profile'} linked from the studio's own website: ${esc(l.linkedin_url)}"
      >${liIcon(16)}<span class="li-tick">✓</span></a>`;
  }
  const searches = people.linkedinSearches({
    contactName: l.contact_name, studio: l.name, appName: l.top_app, country: l.country
  });
  if (!searches.length) return '<span class="muted" title="Not enough signal to build a useful search">—</span>';
  const links = searches.map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.why)}">${liIcon(13)} ${esc(s.label)}</a>`
  ).join('');
  return `<details class="find"><summary class="li li-off"
      title="No LinkedIn found on their site. ${searches.length} ready-made searches - you pick the right person."
      >${liIcon(16)}<span class="li-n">${searches.length}</span></summary><div class="findbox">${links}</div></details>`;
}

// The verified URL itself, spelled out - findPersonCell's blue icon links to
// the same profile, but as an icon it cannot be read at a glance or scanned
// down a column. Blank (not a search prompt) when nothing was found: this
// column is only ever the certain case, never the guess.
function linkedinLinkCell(l) {
  if (!l.linkedin_url) return '<span class="muted">—</span>';
  const label = l.linkedin_url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return `<a href="${esc(l.linkedin_url)}" target="_blank" rel="noopener" title="${esc(l.linkedin_url)}">${esc(label)}</a>`;
}

/* ---- status option lists + colors ---- */
const OUTREACH_OPTS = ['', 'Email Sent', 'Follow-up 1 Sent', 'Follow-up 2 Sent', 'Sequence Closed'];
const RESPONSE_OPTS = ['', 'Respond', 'Booked a call', 'Reviewing Data', 'Negotiating Price',
  'Too Expensive', 'Maybe in the Future', 'Not Relevant', 'No Response'];
const STATUS_COLOR = {
  'Email Sent': '#3b82f6', 'Follow-up 1 Sent': '#f59e0b', 'Follow-up 2 Sent': '#f97316',
  'Sequence Closed': '#6b7280', 'Respond': '#10b981', 'Booked a call': '#059669',
  'Reviewing Data': '#7c3aed', 'Negotiating Price': '#d97706', 'Too Expensive': '#b91c1c',
  'Maybe in the Future': '#0e7490', 'Not Relevant': '#ef4444', 'No Response': '#6b7280'
};
function optionList(opts, current) {
  return opts.map((o) =>
    `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o || '—')}</option>`).join('');
}
function selectCell(id, name, opts, current, backHere) {
  const c = STATUS_COLOR[current] || '';
  const style = c ? ` style="border-left:4px solid ${c}"` : '';
  const title = name === 'outreach'
    ? 'Outreach status — where this lead is in the sequence. Set automatically as emails go out; change here to override.'
    : 'Response status — set to “Respond” automatically when they reply. You set “Booked a call”, “Reviewing Data” (once they have given us access and we are going through their numbers), “Negotiating Price”, “Too Expensive”, “Maybe in the Future”, “Not Relevant” or “No Response” yourself.';
  return `<form method="post" action="/action/${id}/set" class="sel">
    <input type="hidden" name="back" value="${esc(backHere)}">
    <select name="${name}" title="${esc(title)}" onchange="this.form.submit()"${style}>${optionList(opts, current)}</select>
  </form>`;
}

// Set by hand as a negotiation moves - not sourced from any API, so a plain
// editable number rather than the read-only $ columns further left. Saves on
// change (blur or Enter), same one-field-at-a-time pattern as selectCell.
function priceCell(l, field, backHere, title) {
  const n = Number(l[field]);
  const val = n > 0 ? n : '';
  return `<form method="post" action="/action/${l.id}/set" class="sel" style="display:inline-flex;align-items:center;gap:.2rem">
    <input type="hidden" name="back" value="${esc(backHere)}">
    $<input type="number" name="${field}" value="${esc(val)}" placeholder="—" min="0" step="1"
       title="${esc(title)}" style="width:85px" onchange="this.form.submit()">
  </form>`;
}

/**
 * The page frame. `side` is the optional settings-drawer content; when it is
 * given, `sideOpen` decides whether the drawer starts open (rendered from
 * ?panel=settings, so a save can come back with it still open) and `closeHref`
 * is where the ✕ and the scrim point for browsers with no JS.
 */
function shell(inner, side, sideOpen, closeHref) {
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
  .tile{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;
        padding:.7rem .9rem;color:inherit;text-decoration:none;transition:border-color .12s,transform .12s}
  /* text-decoration is repeated here because the global a:hover rule below is
     more specific than .tile, and would underline the number and the label. */
  .tile:hover{border-color:var(--accent);transform:translateY(-1px);text-decoration:none}
  .tile.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
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
  /* Without this, a <select> sizes itself to its widest <option> (Category's
     "MAPS_AND_NAVIGATION", LinkedIn's "Verified (found on their site)") -
     some cells stay short, others overflow their column, and the grid stops
     lining up into even rows. Match the input rule above so every control in
     the grid is the same width as its cell, regardless of option text. */
  .grid select{width:100%;margin-top:.2rem}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  /* The reply page's own conversation view. Roomier than a fixed pixel cap -
     most of the viewport height, so it reads like the mail thread it is
     rather than a cramped preview box you have to fight with. */
  .thread{max-height:min(62vh,640px);overflow-y:auto}
  @media (max-width: 760px) {
    /* A second, nested scrollbar inside an already-scrolling phone screen is
       the uncomfortable part - one scroll gesture beats two competing ones.
       Let the thread flow with the page instead; scrollIntoView (JS) still
       opens it at the newest message either way. */
    .thread{max-height:none;overflow:visible}
  }
  .wrap{overflow-x:auto}
  /* Card list for narrow screens - built from the same lead data and cell
     helpers as the table, just stacked instead of columned. Hidden by default;
     the media query below swaps it in for the table under ~760px, where the
     table needs sideways scrolling past the pinned columns to read anything. */
  .cards{display:none}
  .lcard{background:var(--panel);border:1px solid var(--line);border-radius:12px;
         padding:.7rem .8rem;margin-bottom:.6rem;font-size:.85rem}
  .lcard.needsreply{border-left:4px solid #f43f5e}
  .lcard-row{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
  .lcard-name{display:flex;align-items:center;gap:.4rem;min-width:0}
  .lcard .ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .lcard-row form.sel{flex:1;min-width:0}
  .lcard select{font-size:.82rem;width:100%}
  .lcard-reply{margin-top:.4rem;padding:.4rem .5rem;background:var(--bg);border-radius:8px;font-size:.82rem}
  .lcard-actions{flex-wrap:wrap;gap:.4rem;margin-top:.5rem}
  @media (max-width: 760px) {
    .wide-only{display:none}
    .card.wrap{display:none}
    .cards{display:block}
  }
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  th,td{padding:.5rem .6rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{position:sticky;top:0;background:var(--panel);font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);z-index:1}
  tbody tr:hover{background:var(--hover)}
  td.ell{max-width:190px;overflow:hidden;text-overflow:ellipsis}
  /* Find-person popover. Scoped to .find so it cannot leak into other <details>. */
  details.find{position:relative}
  details.find>summary{cursor:pointer;list-style:none;white-space:nowrap}
  details.find>summary::-webkit-details-marker{display:none}
  /* Fixed, not absolute: the table wrapper computes to overflow-y:hidden, which
     would clip this panel — badly for rows near the bottom, where it becomes
     invisible and unclickable. Fixed escapes the clip; JS places it on open. */
  /* Parked off-screen until JS places it, so an unpositioned fixed panel can
     never nudge layout or trigger a scroll as it appears. */
  details.find .findbox{position:fixed;left:-9999px;top:-9999px;z-index:60;background:var(--panel);color:var(--ink);
    border:1px solid var(--line);border-radius:8px;padding:.5rem .6rem;
    box-shadow:0 8px 24px rgba(0,0,0,.22);white-space:nowrap;font-size:.8rem;line-height:1.7}
  details.find .findbox a{display:flex;align-items:center;gap:.35rem;padding:.12rem 0;color:#0A66C2}
  /* LinkedIn marks. Blue = a profile they published; grey = searches only. */
  .li{display:inline-flex;align-items:center;gap:.15rem;text-decoration:none}
  .li-on{color:#0A66C2}
  .li-on:hover{color:#004182}
  .li-off{color:var(--muted)}
  .li-off:hover{color:#0A66C2}
  .li-tick{font-size:.7rem;color:#059669;font-weight:700}
  .li-n{font-size:.7rem;font-weight:600}
  /* Pin the Studio (first) and Actions (last) columns so they stay on screen. */
  th:first-child,td:first-child{position:sticky;left:0;background:var(--panel);z-index:2;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  th:last-child,td:last-child{position:sticky;right:0;background:var(--panel);z-index:2;box-shadow:-6px 0 6px -6px rgba(0,0,0,.25)}
  thead th:first-child,thead th:last-child{z-index:3}
  tbody tr:hover td:first-child,tbody tr:hover td:last-child{background:var(--hover)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  /* Someone wrote and is still waiting on an answer. The stripe rides on the
     pinned first cell so it stays on screen however far the table is scrolled;
     the Reply column can be scrolled right out of view. */
  tr.needsreply td:first-child{box-shadow:inset 4px 0 0 #f43f5e}
  tr.needsreply td{background:#fff1f2}
  tr.needsreply td:first-child,tr.needsreply td:last-child{background:#fff1f2}
  tr.needsreply:hover td{background:#ffe4e6}
  tr.needsreply:hover td:first-child,tr.needsreply:hover td:last-child{background:#ffe4e6}
  @media (prefers-color-scheme:dark){
    tr.needsreply td,tr.needsreply td:first-child,tr.needsreply td:last-child{background:#2a1417}
    tr.needsreply:hover td,tr.needsreply:hover td:first-child,tr.needsreply:hover td:last-child{background:#3a1b1f}
  }
  a.unanswered{display:inline-block;background:#f43f5e;color:#fff;font-size:.66rem;font-weight:700;
    letter-spacing:.03em;padding:.05rem .35rem;border-radius:999px;white-space:nowrap;text-decoration:none}
  a.unanswered:hover{background:#e11d48}
  .aitools{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;padding:.5rem .6rem;
    background:var(--chip);border:1px solid var(--line);border-radius:8px}
  .aitools button{padding:.25rem .5rem;font-size:.8rem}
  .aitools select,.aitools input{font:inherit;font-size:.8rem;padding:.22rem .3rem;
    border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink)}
  .aitools button[disabled]{opacity:.45;cursor:not-allowed}
  .tmsg{font-size:.7rem;padding:.05rem .35rem;border-radius:999px;border:1px solid var(--line);
    background:var(--panel);color:var(--muted);cursor:pointer}
  .tmsg:hover{color:var(--accent);border-color:var(--accent)}
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

  /* ---- settings drawer -------------------------------------------------
     The open state lives on <body>, not on the aside, so the server can
     render the drawer already open for ?panel=settings with no JS at all.
     That is what keeps it open across a save round-trip. */
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:80;
         opacity:0;pointer-events:none;transition:opacity .18s}
  body.side-open .scrim{opacity:1;pointer-events:auto}
  .side{position:fixed;top:0;right:0;height:100dvh;width:min(430px,100%);z-index:90;
        background:var(--panel);border-left:1px solid var(--line);overflow-y:auto;
        padding:1rem;transform:translateX(102%);transition:transform .2s ease;
        box-shadow:-12px 0 28px rgba(0,0,0,.18)}
  body.side-open .side{transform:none}
  .side-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.8rem}
  .side-head h2{font-size:1rem;margin:0;font-weight:650}
  .side-x{margin-left:auto;font-size:1.4rem;line-height:1;color:var(--muted);padding:0 .4rem}
  .side-x:hover{color:var(--ink);text-decoration:none}
  .side details.crit{margin-bottom:.6rem;padding:.6rem .8rem}
  /* The drawer is far narrower than the page the criteria grid was built
     for, so let it fall to two columns instead of stretching one. */
  .side .grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
  .side .toolgrid{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.5rem}
  .side .seg{flex-wrap:wrap}

  /* ---- filter card ----------------------------------------------------- */
  .filters{background:var(--panel);border:1px solid var(--line);border-radius:12px;
           padding:.6rem .8rem;margin:.4rem 0 .8rem}
  .search{position:relative;display:inline-flex;align-items:center;flex:1 1 200px;min-width:170px}
  .search input{width:100%;padding-left:1.75rem}
  .search::before{content:"🔍";position:absolute;left:.45rem;font-size:.78rem;opacity:.55;pointer-events:none}
  /* Every applied filter, visible and individually removable. Without this a
     filter set inside the collapsed "More filters" panel is invisible, and
     the only way out is Clear-everything. */
  .chips{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin-top:.5rem}
  .chip{display:inline-flex;align-items:center;gap:.35rem;background:var(--chip);color:var(--accent);
        border:1px solid var(--line);border-radius:999px;padding:.12rem .5rem;font-size:.78rem;font-weight:600}
  .chip a{color:inherit;opacity:.65;font-weight:700;text-decoration:none;line-height:1}
  .chip a:hover{opacity:1;text-decoration:none}
  .fcount{display:inline-block;min-width:1.15rem;padding:0 .3rem;border-radius:999px;background:var(--accent);
          color:var(--accent-ink);font-size:.68rem;font-weight:700;text-align:center;vertical-align:.05rem}
  /* Destructive bulk buttons stay out of sight until something is ticked. */
  .bulkbar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.4rem 0;padding:.45rem .7rem;
           background:var(--chip);border:1px solid var(--accent);border-radius:10px}
  .bulkbar[hidden]{display:none}
</style></head><body${sideOpen ? ' class="side-open"' : ''}><div class="container">${inner}</div>
${side ? `<a class="scrim" id="sidescrim" href="${esc(closeHref)}" aria-label="Close settings"></a>
<aside class="side" id="sidepanel">${side}</aside>` : ''}
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

  // The LinkedIn search popovers are <details>, which stay open until clicked
  // again. Close them the way a menu is expected to behave: on a click
  // elsewhere, on Escape, and when the pointer leaves. Only one open at a time.
  // Open a conversation at its newest message. The reply answers that one, so
  // starting at the top of a long thread shows the least useful part.
  // scrollIntoView on the last bubble (not el.scrollTop) works the same way
  // whether the thread scrolls in its own box (desktop) or flows with the
  // page itself (mobile, under 760px - see the .thread media query), so
  // "open at the newest message" holds in both layouts.
  document.querySelectorAll('.thread').forEach(function(el){
    var msgs = el.children;
    if(msgs.length) msgs[msgs.length - 1].scrollIntoView({ block: 'start' });
  });

  var openedAt = 0;   // when a panel was last opened, to tell apart the browser's
                      // own scroll-into-view from a scroll the user performed
  function closeAll(except){
    document.querySelectorAll('details.find[open]').forEach(function(d){
      if(d !== except) d.removeAttribute('open');
    });
  }
  document.addEventListener('click', function(e){
    var t = e.target;
    // SVG children carry closest(); anything else that does not is outside.
    var inside = (t && typeof t.closest === 'function') ? t.closest('details.find') : null;
    // Stamp synchronously, here in the click. The toggle event fires
    // asynchronously, so a scroll landing in between would otherwise look like
    // a user scroll and close the panel the instant it opened.
    if(inside) openedAt = Date.now();
    closeAll(inside);
  });
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    closeAll(null);
    // Same key, same handler - a second keydown listener would race this one.
    setSide(false);
  });
  // Close shortly after the pointer leaves, with a grace period so crossing the
  // gap between the icon and the panel does not shut it. Mouse only: on a touch
  // screen there is no hover, and a stray mouseleave would close the panel the
  // instant it opened - there, the click-elsewhere rule above does the job.
  if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.querySelectorAll('details.find').forEach(function(d){
      var t = null;
      d.addEventListener('mouseleave', function(){
        clearTimeout(t);
        t = setTimeout(function(){ d.removeAttribute('open'); }, 400);
      });
      d.addEventListener('mouseenter', function(){ clearTimeout(t); });
    });
  }
  // Scrolling the table sideways would leave the panel floating over unrelated
  // rows, so close on scroll - but NOT the scroll the browser performs to bring
  // the icon into view when you click it, which would shut the panel the moment
  // it opened.
  // Place the fixed panel under its icon, kept inside the viewport. Flips above
  // the icon when there is no room below, so bottom rows still show it fully.
  function place(d){
    var box = d.querySelector('.findbox');
    if(!box) return;
    box.style.visibility = 'hidden';
    box.style.left = '0px'; box.style.top = '0px';
    var r = d.getBoundingClientRect();
    var bw = box.offsetWidth, bh = box.offsetHeight, pad = 8;
    var left = Math.min(Math.max(pad, r.right - bw), window.innerWidth - bw - pad);
    var top = r.bottom + 4;
    if(top + bh > window.innerHeight - pad) top = Math.max(pad, r.top - bh - 4);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.visibility = '';
  }
  document.addEventListener('toggle', function(e){
    var d = e.target;
    if(!d.matches || !d.matches('details.find')) return;
    if(!d.hasAttribute('open')) return;
    openedAt = Date.now();
    place(d);
  }, true);
  window.addEventListener('resize', function(){ closeAll(null); });
  window.addEventListener('scroll', function(){
    if(Date.now() - openedAt > 500) closeAll(null);
  }, { passive: true });
  document.querySelectorAll('.wrap').forEach(function(el){
    el.addEventListener('scroll', function(){
      if(Date.now() - openedAt > 500) closeAll(null);
    }, { passive: true });
  });

  // ---- settings drawer ---------------------------------------------------
  // The ⚙ button and the ✕/scrim are real links (?panel=settings and back),
  // so the drawer works with JS off. Here we intercept them and just toggle
  // the class, which avoids a page load for what is only a panel opening.
  // The URL is kept in sync so a refresh - or a form inside the drawer that
  // posts and redirects - lands in the same state.
  function setSide(on){
    if(!document.getElementById('sidepanel')) return;
    document.body.classList.toggle('side-open', on);
    if(!window.history || !history.replaceState) return;
    var u = new URL(window.location.href);
    if(on) u.searchParams.set('panel','settings'); else u.searchParams.delete('panel');
    history.replaceState(null, '', u.pathname + (u.search || '') );
  }
  document.addEventListener('click', function(e){
    var t = e.target;
    if(!t || typeof t.closest !== 'function') return;
    var open = t.closest('[data-side="open"]');
    var shut = t.closest('[data-side="close"]');
    if(!open && !shut) return;
    e.preventDefault();
    setSide(!!open);
  });

  // ---- bulk actions appear only once rows are ticked ---------------------
  // A lead renders its checkbox twice (mobile card + table row), so count
  // distinct values - a raw length double-reports every selection.
  var bulkbar = document.querySelector('.bulkbar');
  var syncBulk = function(){};
  if(bulkbar){
    var out = bulkbar.querySelector('.bulkcount');
    syncBulk = function(){
      var seen = {}, n = 0;
      document.querySelectorAll('.rowchk:checked').forEach(function(c){
        if(!seen[c.value]){ seen[c.value] = 1; n++; }
      });
      bulkbar.hidden = n === 0;
      if(out) out.textContent = n + (n === 1 ? ' lead selected' : ' leads selected');
    };
    document.addEventListener('change', function(e){
      if(e.target && e.target.classList && e.target.classList.contains('rowchk')) syncBulk();
    });
    syncBulk();
  }
  // Two explicit buttons rather than one checkbox - ticking every row shown
  // with a single click is the point, and "select all" reads as an action,
  // not a state to toggle. Both tick/untick every .rowchk in one pass (a
  // lead's checkbox renders twice - mobile card and desktop row - so both
  // copies of it move together).
  document.querySelectorAll('[data-selectall]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var on = btn.getAttribute('data-selectall') === '1';
      document.querySelectorAll('.rowchk').forEach(function(c){ c.checked = on; });
      syncBulk();
    });
  });

  // ---- reading the table for copy / export --------------------------------
  // Shared by both Copy table and Export to Excel, so they can never disagree
  // about what a cell's real value is. Selecting one or more rows scopes
  // either action to just those leads; with nothing ticked, both act on
  // every row currently shown (respecting the active filter/search/sort) -
  // "mark one, mark all, or mark nothing" are all valid starting points.
  function cellText(cell){
    // A <select> cell (Outreach/Response) carries every <option>'s text in
    // textContent regardless of which is selected - only the chosen one is
    // the actual data.
    var sel = cell.querySelector('select');
    if(sel) return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
    // A plain editable <input> (Asking/Our price) has no textContent at all -
    // its value lives in the value attribute, not as rendered text. Every
    // such form also carries a hidden "back" field before the visible
    // control, so it has to be excluded explicitly or it wins the query.
    var inp = cell.querySelector('input:not(.rowchk):not([type="hidden"])');
    if(inp) return inp.value || '';
    // Everything else that is a page control rather than a fact about the
    // lead (the row checkbox, the Preview/Send/Block/Delete buttons and
    // their forms) contributes no text once removed.
    var clone = cell.cloneNode(true);
    clone.querySelectorAll('form,button').forEach(function(n){ n.remove(); });
    return clone.textContent.replace(/\\s+/g, ' ').trim();
  }
  function getTableRows(){
    var table = document.getElementById('leadsTable');
    if(!table) return null;
    var head = table.querySelector('thead tr');
    // The empty-table state is one placeholder <tr><td colspan> - "No leads
    // yet", not a row of data. A rowchk-less row is never a real lead.
    var body = Array.prototype.slice.call(table.querySelectorAll('tbody tr'))
      .filter(function(tr){ return tr.querySelector('.rowchk'); });
    var checkedIds = {};
    document.querySelectorAll('.rowchk:checked').forEach(function(c){ checkedIds[c.value] = 1; });
    var anySelected = Object.keys(checkedIds).length > 0;
    if(anySelected){
      body = body.filter(function(tr){
        var chk = tr.querySelector('.rowchk');
        return chk && checkedIds[chk.value];
      });
    }
    var rows = (head ? [head] : []).concat(body);
    return { cells: rows.map(function(tr){ return Array.prototype.map.call(tr.querySelectorAll('th,td'), cellText); }),
      count: body.length, scoped: anySelected };
  }
  function flashButton(btn, text){
    var orig = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', orig);
    btn.textContent = text;
    setTimeout(function(){ btn.textContent = orig; }, 1500);
  }

  // ---- copy the table (selected rows, or every shown row) as TSV ---------
  // Reads the real <table> in the DOM, not a re-fetch, so it always matches
  // whatever filter/search/sort produced this exact page - no separate
  // "what should I export" logic to keep in sync with the table itself.
  var copyBtn = document.getElementById('copyTableBtn');
  if(copyBtn){
    copyBtn.addEventListener('click', function(){
      var data = getTableRows();
      if(!data || !data.count){ flashButton(copyBtn, '⚠️ Nothing to copy'); return; }
      var tsv = data.cells.map(function(row){ return row.join('\\t'); }).join('\\n');
      var label = '✅ Copied ' + data.count + (data.count === 1 ? ' row!' : ' rows!');
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(tsv).then(function(){ flashButton(copyBtn, label); }, function(){ flashButton(copyBtn, '⚠️ Copy failed'); });
        return;
      }
      // Fallback for browsers with no Clipboard API (or a non-HTTPS origin).
      var ta = document.createElement('textarea');
      ta.value = tsv; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); flashButton(copyBtn, label); }
      catch(e){ flashButton(copyBtn, '⚠️ Copy failed'); }
      document.body.removeChild(ta);
    });
  }

  // ---- export the table (selected rows, or every shown row) as a .csv ----
  var exportBtn = document.getElementById('exportTableBtn');
  if(exportBtn){
    exportBtn.addEventListener('click', function(){
      var data = getTableRows();
      if(!data || !data.count){ flashButton(exportBtn, '⚠️ Nothing to export'); return; }
      var csv = data.cells.map(function(row){
        return row.map(function(v){
          return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',');
      }).join('\\r\\n');
      // A UTF-8 BOM so Excel reads non-ASCII text (Hebrew, emoji, ×) correctly
      // instead of mangling it - Excel's CSV auto-detection needs the hint.
      var blob = new Blob(['\\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var stamp = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = 'leads-' + stamp + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      flashButton(exportBtn, '✅ Exported ' + data.count + (data.count === 1 ? ' row!' : ' rows!'));
    });
  }
})();
</script>
</body></html>`;
}

function makeApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // The editing tools post JSON. Capped because a draft is a few KB, not a file.
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (req, res) => res.send('ok'));
  app.use(basicAuth);

  app.get('/', async (req, res) => {
    try {
      const leads = await db.allLeads();
      const S = config.statuses;
      const sentToday = await db.countToday(['initial', 'fu1', 'fu2']);
      const sentTodayIds = await db.leadIdsToday(['initial', 'fu1', 'fu2']);

      // One predicate per tile, used for BOTH the number on the tile and the
      // rows you get when you click it - so a tile reading 130 can never open a
      // list of 128. Clicking sets ?view=<key>.
      const TILES = [
        { key: 't_today', label: 'Sent today', test: (l) => sentTodayIds.has(l.id),
          hint: 'The leads emailed today' },
        { key: 'queue', label: 'Queue', test: (l) => !l.outreach && l.email && l.grp !== config.groups.blockList,
          hint: 'Sourced, has an email, not contacted yet' },
        { key: 't_sent', label: 'Email sent', test: (l) => l.outreach === S.emailSent,
          hint: 'First email out, no follow-up yet' },
        { key: 't_fu1', label: 'Follow-up 1', test: (l) => l.outreach === S.fu1Sent },
        { key: 't_fu2', label: 'Follow-up 2', test: (l) => l.outreach === S.fu2Sent },
        { key: 'replied', label: 'Replied', test: (l) => l.response === config.responses.respond,
          hint: 'They wrote back' },
        { key: 'booked', label: 'Booked calls', test: (l) => l.response === config.responses.bookedCall,
          hint: 'A call is scheduled with them - the funnel is working' },
        { key: 'reviewing', label: 'Reviewing Data', test: (l) => l.response === config.responses.reviewingData,
          hint: 'They gave us access and we are going through their numbers' },
        { key: 'negotiating', label: 'Negotiating Price', test: (l) => l.response === config.responses.negotiatingPrice,
          hint: 'Talking numbers - the deal is close' },
        { key: 'expensive', label: 'Too Expensive', test: (l) => l.response === config.responses.tooExpensive,
          hint: 'They pushed back on the number' },
        { key: 'maybe', label: 'Maybe in the Future', test: (l) => l.response === config.responses.maybeLater,
          hint: 'Not now - worth another look down the line' },
        { key: 't_closed', label: 'Closed', test: (l) => l.outreach === S.sequenceClosed,
          hint: 'Sequence finished or stopped - bounced, or no answer after both follow-ups' },
        { key: 'blocked', label: 'Blocked', test: (l) => l.grp === config.groups.blockList }
      ];
      // Sent-today is a count of leads; the quota line above counts sends. They
      // differ only if one lead got two sends in a day, which the follow-up
      // delays make impossible - but count the rows, so the tile matches its list.
      const tileCounts = {};
      for (const t of TILES) tileCounts[t.key] = leads.filter(t.test).length;
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
      // Conversations that need an answer, newest message first. A lead is
      // "awaiting us" when their last message is newer than our last one -
      // which is the only way to notice someone writing again after we replied.
      // Annotate in place so the banner, the row highlight and the counts all
      // agree — one definition of "they are waiting on us", not three.
      for (const l of leads) {
        l.awaitingUs = !!(l.last_outbound_at && l.last_inbound_at && l.last_inbound_at > l.last_outbound_at);
        l.needsReply = !!(l.reply_snippet && l.grp !== config.groups.blockList &&
          (l.awaitingUs || (l.response === config.responses.respond && !l.last_outbound_at)));
      }
      const waiting = leads
        .filter((l) => l.needsReply)
        .sort((a, b) => String(b.last_inbound_at || '').localeCompare(String(a.last_inbound_at || '')));
      // A booked call, an open data review, or an active price negotiation is
      // a conversation already moving, not one waiting on an answer. That
      // status was set by hand, so it is a stronger statement about where the
      // lead stands than the mechanical "their message is newer" test - and
      // the banner should stop asking.
      const QUIET_RESPONSES = [config.responses.bookedCall, config.responses.reviewingData, config.responses.negotiatingPrice];
      const isQuiet = (l) => QUIET_RESPONSES.includes(l.response);
      // A deal marked Too Expensive, Not Relevant or No Response is finished,
      // not paused - there is nothing left to say, so a stray message after
      // that tag (a "thanks anyway", a last remark) should not nag the
      // banner. Unlike QUIET_RESPONSES this gets no footer mention either:
      // those are still-open deals worth another look, this one is closed -
      // if it needs revisiting, its own tile is right there.
      const FINAL_RESPONSES = [config.responses.tooExpensive, config.responses.notRelevant, config.responses.noResponse];
      const isFinal = (l) => FINAL_RESPONSES.includes(l.response);
      // needsReply itself stays purely mechanical everywhere else (the row
      // stripe, the tiles) - never let an AI guess hide a lead there. The
      // banner is just a nag list though, so it is allowed to lean on the AI:
      // drop a lead from it only when the AI found no action needed AND they
      // have not written again since our last reply (the strongest signal
      // that they really are still waiting on us).
      const bannerWaiting = waiting.filter((l) =>
        !isFinal(l) && !isQuiet(l) && !(l.ai_action_needed === 'no' && !l.awaitingUs));
      const awaitingCount = bannerWaiting.filter((l) => l.awaitingUs).length;
      // Hidden, not forgotten: they still wrote, and one of them rescheduling
      // or sending numbers matters. One muted line, no cards.
      const quietCount = waiting.filter(isQuiet).length;

      // Status only — the keys themselves never reach the page.
      const aiKey = await ai.keyStatus();
      const apifyKey = await apify.keyStatus();
      const cov = await db.contactCoverage();
      cov.needs_enrich = leads.filter((l) =>
        String(l.website || '').trim() &&
        (!String(l.contact_name || '').trim() || !String(l.linkedin_url || '').trim() ||
         !String(l.phone || '').trim()) &&
        !String(l.site_checked_at || '').trim()).length;
      const lastWatchRun = await db.getSetting('last_watch_run', '');
      const lastWatchStatus = await db.getSetting('last_watch_status', 'never run yet');
      const gmailConnected = await email.isConnected();
      const replyAlertsOn = (await db.getSetting('reply_alert_enabled', 'true')) !== 'false';
      const redirectUri = baseUrl(req) + '/oauth/callback';

      // View filter (defaults to hiding the Block List).
      const view = req.query.view || 'nonblocked';
      const BL = config.groups.blockList;
      const R = config.responses;
      let shown = leads;
      // A tile's own predicate wins, so clicking it shows exactly what it counted.
      const tileView = TILES.filter((t) => t.key === view)[0];
      if (tileView) shown = leads.filter(tileView.test);
      else if (view === 'nonblocked') shown = leads.filter((l) => l.grp !== BL);
      else if (view === 'contacted') shown = leads.filter((l) => l.outreach && l.grp !== BL);
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
        instDayMin: qp.f_instDayMin, instDayMax: qp.f_instDayMax,
        ratingMin: qp.f_ratingMin,
        revMax: qp.f_revMax, rpiMax: qp.f_rpiMax,
        appsMin: qp.f_appsMin, appsMax: qp.f_appsMax,
        prioMax: qp.f_prioMax,
        category: qp.f_category || '',
        country: (qp.f_country || '').trim().toLowerCase(),
        group: (qp.f_group || '').trim().toLowerCase(),
        site: qp.f_site || '',
        contact: qp.f_contact || '',
        phone: qp.f_phone || '',
        // The important one: a blue LinkedIn icon (found on the studio's own
        // site) is a real link; a grey one only opens search suggestions.
        // Filtering must respect that distinction, not just "has a value".
        linkedin: qp.f_linkedin || '',
        askMin: qp.f_askMin, askMax: qp.f_askMax,
        offMin: qp.f_offMin, offMax: qp.f_offMax
      };
      // One list drives the chip row, the "N active" badge and whether any
      // filter is on at all - the same reason TILES owns both its count and
      // its predicate. A hand-maintained boolean beside a hand-maintained
      // chip list is exactly how "Clear filters" goes missing for one field.
      // `adv` marks the ones hidden inside the collapsed More-filters panel.
      const CHIPS = [
        { k: 'q', label: (v) => `“${v}”` },
        { k: 'platform', label: (v) => (v === 'ios' ? '🍎 iOS' : '🤖 Android') },
        { k: 'f_outreach', adv: true, label: (v) => `Outreach: ${v}` },
        { k: 'f_response', adv: true, label: (v) => `Response: ${v}` },
        { k: 'f_oppMin', adv: true, label: (v) => `Opp ≥ ${v}` },
        { k: 'f_oppMax', adv: true, label: (v) => `Opp ≤ ${v}` },
        { k: 'f_instMin', adv: true, label: (v) => `Installs ≥ ${num(v)}` },
        { k: 'f_instMax', adv: true, label: (v) => `Installs ≤ ${num(v)}` },
        { k: 'f_instDayMin', adv: true, label: (v) => `Inst/day ≥ ${num(v)}` },
        { k: 'f_instDayMax', adv: true, label: (v) => `Inst/day ≤ ${num(v)}` },
        { k: 'f_ratingMin', adv: true, label: (v) => `★ ≥ ${v}` },
        { k: 'f_revMax', adv: true, label: (v) => `Rev/mo ≤ $${num(v)}` },
        { k: 'f_rpiMax', adv: true, label: (v) => `$/inst ≤ $${v}` },
        { k: 'f_appsMin', adv: true, label: (v) => `Apps ≥ ${v}` },
        { k: 'f_appsMax', adv: true, label: (v) => `Apps ≤ ${v}` },
        { k: 'f_prioMax', adv: true, label: (v) => `Priority ≤ ${num(v)}` },
        { k: 'f_category', adv: true, label: (v) => `Category: ${v}` },
        { k: 'f_country', adv: true, label: (v) => `Country: ${v}` },
        { k: 'f_group', adv: true, label: (v) => `Group: ${v}` },
        { k: 'f_site', adv: true, label: (v) => (v === 'yes' ? 'Has website' : 'No website') },
        { k: 'f_contact', adv: true,
          label: (v) => ({ verified: 'Contact: verified', guessed: 'Contact: guessed', none: 'Contact: none' }[v] || v) },
        { k: 'f_phone', adv: true, label: (v) => (v === 'yes' ? 'Has phone' : 'No phone') },
        { k: 'f_linkedin', adv: true,
          label: (v) => (v === 'verified' ? '🔗 LinkedIn verified' : 'LinkedIn: search only') },
        { k: 'f_askMin', adv: true, label: (v) => `Asking ≥ $${num(v)}` },
        { k: 'f_askMax', adv: true, label: (v) => `Asking ≤ $${num(v)}` },
        { k: 'f_offMin', adv: true, label: (v) => `Our price ≥ $${num(v)}` },
        { k: 'f_offMax', adv: true, label: (v) => `Our price ≤ $${num(v)}` }
      ];
      const activeChips = CHIPS.filter((c) => String(qp[c.k] || '').trim() !== '');
      const anyFilterActive = activeChips.length > 0;
      const advCount = activeChips.filter((c) => c.adv).length;
      // This exact URL with one param set or removed. Rebuilding from req.url
      // means everything else currently applied survives untouched - which is
      // what lets a chip's × drop only its own filter, and lets the settings
      // drawer keep itself open across a save without disturbing the view.
      const urlWith = (k, v) => {
        const p = new URLSearchParams(req.url.split('?')[1] || '');
        if (v === null) p.delete(k); else p.set(k, v);
        const s = p.toString();
        return '/' + (s ? '?' + s : '');
      };
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
          const instDayMin = num2(f.instDayMin), instDayMax = num2(f.instDayMax);
          if (instDayMin !== null && Number(l.installs_day) < instDayMin) return false;
          if (instDayMax !== null && Number(l.installs_day) > instDayMax) return false;
          const rpiMax = num2(f.rpiMax);
          if (rpiMax !== null && Number(l.rev_per_install) > rpiMax) return false;
          if (f.category && l.category !== f.category) return false;
          if (f.country && !String(l.country || '').toLowerCase().includes(f.country)) return false;
          if (f.group && !String(l.grp || '').toLowerCase().includes(f.group)) return false;
          if (f.site === 'yes' && !String(l.website || '').trim()) return false;
          if (f.site === 'no' && String(l.website || '').trim()) return false;
          if (f.phone === 'yes' && !String(l.phone || '').trim()) return false;
          if (f.phone === 'no' && String(l.phone || '').trim()) return false;
          // 'verified' = read off the studio's own site (contactCell's ✅);
          // 'guessed' = split from the email address (contactCell's ~).
          if (f.contact === 'verified' && l.contact_name_source !== 'site') return false;
          if (f.contact === 'guessed' && !(String(l.contact_name || '').trim() && l.contact_name_source !== 'site')) return false;
          if (f.contact === 'none' && String(l.contact_name || '').trim()) return false;
          // 'verified' = a profile the studio published on its own site
          // (blue icon, a real link); 'search' = nothing found, only the
          // ready-made search suggestions (grey icon) - never treat those two
          // as the same "has LinkedIn" bucket.
          if (f.linkedin === 'verified' && !String(l.linkedin_url || '').trim()) return false;
          if (f.linkedin === 'search' && String(l.linkedin_url || '').trim()) return false;
          const askMin = num2(f.askMin), askMax = num2(f.askMax);
          if (askMin !== null && Number(l.asking_price) < askMin) return false;
          if (askMax !== null && Number(l.asking_price) > askMax) return false;
          const offMin = num2(f.offMin), offMax = num2(f.offMax);
          if (offMin !== null && Number(l.offer_price) < offMin) return false;
          if (offMax !== null && Number(l.offer_price) > offMax) return false;
          return true;
        });
      }

      // Column sort. One list of getters, the same one-source-of-truth
      // pattern as TILES/CHIPS, so a header link and its comparator can
      // never drift apart. Text columns compare case-insensitively; numeric
      // columns compare as numbers so "10" does not sort before "9".
      const SORT_FIELDS = {
        name: { text: (l) => l.name || '' },
        app: { text: (l) => l.top_app || l.name || '' },
        os: { text: (l) => l.platform || '' },
        opp: { num: (l) => Number(l.opportunity) || 0 },
        category: { text: (l) => l.category || '' },
        instday: { num: (l) => Number(l.installs_day) || 0 },
        insttotal: { num: (l) => Number(l.installs_total) || 0 },
        apps: { num: (l) => Number(l.apps_count) || 0 },
        rev: { num: (l) => Number(l.revenue_month) || 0 },
        rpi: { num: (l) => Number(l.rev_per_install) || 0 },
        rating: { num: (l) => Number(l.rating_avg) || 0 },
        priority: { num: (l) => Number(l.priority) || 0 },
        email: { text: (l) => l.email || '' },
        site: { num: (l) => (String(l.website || '').trim() ? 1 : 0) },
        contact: { text: (l) => l.contact_name || '' },
        phone: { text: (l) => l.phone || '' },
        country: { text: (l) => l.country || '' },
        // Verified links first (or last, reversed) - not alphabetical by URL,
        // which would just interleave with the unverified rows.
        linkedin: { num: (l) => (String(l.linkedin_url || '').trim() ? 1 : 0) },
        asking: { num: (l) => Number(l.asking_price) || 0 },
        offer: { num: (l) => Number(l.offer_price) || 0 },
        outreach: { text: (l) => l.outreach || '' },
        response: { text: (l) => l.response || '' },
        group: { text: (l) => l.grp || '' }
      };
      const sortKey = Object.prototype.hasOwnProperty.call(SORT_FIELDS, qp.sort || '') ? qp.sort : '';
      const sortDir = qp.dir === 'asc' ? 'asc' : 'desc';
      if (sortKey) {
        const field = SORT_FIELDS[sortKey];
        const get = field.num || field.text;
        const isNum = !!field.num;
        shown = shown.slice().sort((a, b) => {
          const av = get(a), bv = get(b);
          const cmp = isNum ? av - bv : String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
          return sortDir === 'asc' ? cmp : -cmp;
        });
      }
      // Same url, sort set to this column - toggling direction if it is
      // already the active column, defaulting to desc (highest/most-recent
      // first) otherwise. Everything else applied (filters, view, panel)
      // survives, same as urlWith.
      const sortHref = (key) => {
        const nextDir = sortKey === key && sortDir === 'desc' ? 'asc' : 'desc';
        const p = new URLSearchParams(req.url.split('?')[1] || '');
        p.set('sort', key); p.set('dir', nextDir);
        const s = p.toString();
        return '/' + (s ? '?' + s : '');
      };
      const th = (key, label, title) => `<th${title ? ` title="${esc(title)}"` : ''}>
        <a href="${esc(sortHref(key))}" style="color:inherit;text-decoration:none;white-space:nowrap">${esc(label)}${sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</a></th>`;
      // Keep in sync with the <thead> below - it is hand-written, not built
      // from this count, because each cell's markup (sortable vs plain,
      // tooltip text) differs too much to make an array worth it here.
      const COLUMN_COUNT = 27;

      const appCell = (l) => l.store_link
        ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener">${esc(l.top_app || l.name)}</a>`
        : esc(l.top_app || '');

      // Where this exact filtered/searched view lives, so entering a lead
      // (Preview, Reply) or changing its status and coming back lands you back
      // on it - never silently reset to the unfiltered list. Carried as a
      // hidden field on every form and a query param on every link that leaves
      // this page; only "Clear filters" or the ← Back to all on a tile removes
      // it, both by navigating to a plain "/" on purpose.
      const backHere = req.url;
      const backQS = '?back=' + encodeURIComponent(backHere);

      // Settings drawer. Rendering the open state server-side from ?panel is
      // what makes it survive a save: every form inside the drawer carries
      // `back` = this view *with* panel=settings, so /keys, /criteria and the
      // rest redirect back to the same filtered list, drawer still open.
      const sideOpen = req.query.panel === 'settings';
      const backPanel = urlWith('panel', 'settings');
      const closeHref = urlWith('panel', null);

      // The studio name is the one cell always on screen - it is the pinned
      // first column on desktop, and the first thing in every mobile card -
      // so once there is a conversation, it doubles as the click target for
      // it. Reaching the Actions column on a wide table (or scrolling to the
      // bottom of a mobile card) to find "View & Reply" was the friction this
      // fixes; the name itself now opens straight to the same page. Before a
      // reply exists there is no conversation yet, so it stays plain text.
      const studioName = (l) => l.reply_snippet
        ? `<a href="/reply/${l.id}${backQS}" title="Read what they said and draft a reply"><b>${esc(l.name)}</b></a>`
        : `<b>${esc(l.name)}</b>`;

      // Shared between the desktop table and the mobile card list, so the two
      // views can never show different reply/action state for the same lead -
      // only the markup wrapping this changes with the layout.
      const replyCell = (l) => l.reply_snippet
        ? `${l.needsReply
            ? `<a href="/reply/${l.id}${backQS}" class="unanswered" title="They wrote${l.awaitingUs ? ' again, after your last reply' : ''} and you have not answered yet${l.last_inbound_at ? ' — ' + esc(agoLabel(l.last_inbound_at)) : ''}"
                >↩ NEEDS REPLY</a> `
            : ''}<a href="/reply/${l.id}${backQS}" title="Read it and draft an answer that matches what they said">💬 ${esc(l.reply_snippet.slice(0, 60))}…</a>`
        : '';
      // Preview shows the next COLD-sequence email (initial/FU1/FU2) and Send
      // fires it - neither means anything once they've replied: the sequence
      // is done, and sendOne() refuses any lead with a response set anyway.
      // A single "View & Reply" replaces both, pointing at the one place
      // that actually matters now - the same page the Reply column's own
      // snippet link opens, so there is exactly one thing to click, not two
      // that look like alternatives.
      const primaryAction = (l) => l.reply_snippet
        ? `<a href="/reply/${l.id}${backQS}" title="Read what they said and draft a reply"><button type="button" class="send">💬 View &amp; Reply</button></a>`
        : `<form method="get" action="/preview/${l.id}"><input type="hidden" name="back" value="${esc(backHere)}"><button title="See the exact email that will be sent to this lead">👁 Preview</button></form>
          <form method="post" action="/action/${l.id}/send" onsubmit="return confirm('Send the next email in the sequence to this lead now?')"><input type="hidden" name="back" value="${esc(backHere)}"><button class="send" title="Send the next email (initial → FU1 → FU2) to THIS lead now. Respects DRY_RUN.">✉ Send</button></form>`;
      const actionsCell = (l) => `
          ${primaryAction(l)}
          <form method="post" action="/action/${l.id}/block"><input type="hidden" name="back" value="${esc(backHere)}"><button title="Move to Block List — never contacted again, removed from sending & future sourcing">⛔ Block</button></form>
          <form method="post" action="/action/${l.id}/delete" onsubmit="return confirm('Delete this lead permanently? (Block is better for junk — it also prevents re-sourcing.)')"><input type="hidden" name="back" value="${esc(backHere)}"><button title="Delete this lead permanently from the database">🗑</button></form>`;

      const rows = shown.slice(0, 500).map((l) => `<tr${l.needsReply ? ' class="needsreply"' : ''}>
        <td title="${esc(l.name)}"><input type="checkbox" class="rowchk" name="ids" value="${l.id}" form="bulkform"> ${studioName(l)}</td>
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
        <td class="ell">${phoneCell(l)}</td>
        <td class="muted">${esc(l.country)}</td>
        <td>${findPersonCell(l)}</td>
        <td class="ell">${linkedinLinkCell(l)}</td>
        <td>${priceCell(l, 'asking_price', backHere, 'What the studio is asking for the app')}</td>
        <td>${priceCell(l, 'offer_price', backHere, "The number we've offered or are prepared to offer")}</td>
        <td>${selectCell(l.id, 'outreach', OUTREACH_OPTS, l.outreach, backHere)}</td>
        <td>${selectCell(l.id, 'response', RESPONSE_OPTS, l.response, backHere)}</td>
        <td class="ell" title="${esc(l.reply_snippet)}">${replyCell(l)}</td>
        <td class="muted">${esc(l.grp)}</td>
        <td style="white-space:nowrap">${actionsCell(l)}</td>
      </tr>`).join('');

      // A card list for narrow screens - the table needs sideways scrolling to
      // read past the pinned Studio/Actions columns, which is exactly what is
      // hard to do on a phone. Same lead objects, same cell helpers as the
      // table above, just stacked instead of columned - so the two views can
      // never disagree about a lead, only look different.
      const cards = shown.slice(0, 500).map((l) => `
        <div class="lcard${l.needsReply ? ' needsreply' : ''}">
          <div class="lcard-row">
            <label class="lcard-name"><input type="checkbox" class="rowchk" name="ids" value="${l.id}" form="bulkform"> ${studioName(l)}</label>
            <b style="color:${l.opportunity >= 70 ? '#059669' : l.opportunity >= 45 ? '#b45309' : 'inherit'}">${num(l.opportunity)}</b>
          </div>
          <div class="lcard-row muted">
            <span class="ell">${appCell(l)}${appBadge(l)}</span>
            <span>${l.platform === 'ios' ? '🍎' : '🤖'}</span>
          </div>
          ${l.category ? `<div class="muted" style="font-size:.78rem">${esc(l.category)} · ${num(l.installs_day)}/day · $${num(l.revenue_month)}/mo${Number(l.rating_avg) ? ' · ★' + Number(l.rating_avg).toFixed(1) : ''}</div>` : ''}
          <div class="lcard-row" style="margin-top:.35rem;flex-wrap:wrap;gap:.5rem">
            ${l.email ? `<a href="mailto:${esc(l.email)}" title="${esc(l.email)}">✉️</a>` : ''}
            ${l.store_link ? `<a href="${esc(l.store_link)}" target="_blank" rel="noopener" title="Open in the store">↗</a>` : ''}
            ${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener" title="${esc(l.website)}">🌐</a>` : ''}
            <span class="ell">${contactCell(l)}</span>
            <span>${phoneCell(l)}</span>
            <span>${findPersonCell(l)}</span>
          </div>
          <div class="lcard-row" style="margin-top:.35rem;gap:.6rem;font-size:.78rem">
            <span class="muted">Asking ${priceCell(l, 'asking_price', backHere, 'What the studio is asking for the app')}</span>
            <span class="muted">Our ${priceCell(l, 'offer_price', backHere, "The number we've offered or are prepared to offer")}</span>
          </div>
          <div class="lcard-row" style="margin-top:.35rem;gap:.4rem">
            ${selectCell(l.id, 'outreach', OUTREACH_OPTS, l.outreach, backHere)}
            ${selectCell(l.id, 'response', RESPONSE_OPTS, l.response, backHere)}
          </div>
          ${l.reply_snippet ? `<div class="lcard-reply" title="${esc(l.reply_snippet)}">${replyCell(l)}</div>` : ''}
          <div class="lcard-row lcard-actions">${actionsCell(l)}</div>
        </div>`).join('');

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

      // Every tile is a link into the table. Filters and the search box are
      // deliberately dropped: you clicked a total, so you should get that total.
      const tile = (t) => {
        const n = tileCounts[t.key];
        const on = view === t.key;
        return `<a class="tile${on ? ' on' : ''}" href="/?view=${t.key}"
          title="${esc(t.hint || t.label)} - click to list ${n === 1 ? 'it' : 'them'}">
          <div class="n">${n}</div><div class="l">${esc(t.label)}</div></a>`;
      };

      // Everything in the drawer posts back to `backPanel`, so a save returns
      // to this same filtered view with the drawer still open.
      const sidePanel = `
        <div class="side-head">
          <h2>⚙ Settings</h2>
          <a class="side-x" href="${esc(closeHref)}" data-side="close" title="Close settings">✕</a>
        </div>

        <details class="crit" open>
          <summary>✉️ Sending</summary>
          <div class="bar" style="margin:.6rem 0">${dryToggle}<span class="seg">${modeCtl}</span></div>
          <p class="muted" style="font-size:.8rem;margin:.2rem 0">
            Window: <b>${wOpen ? 'OPEN' : 'closed'}</b> (${config.sender.windowStartHour}:00–${config.sender.windowEndHour}:00, Mon–Fri).
            Sent today: <b>${sentToday}</b> of ${quota}.
          </p>
          <form method="post" action="/quota" class="stack" style="margin-top:.4rem">
            <input type="hidden" name="back" value="${esc(backPanel)}">
            <label style="display:block;font-size:.8rem;color:var(--muted)">Emails per day
              <input name="value" value="${crit.dailyQuotaOverride || ''}" placeholder="${quota}" style="width:100%;margin-top:.2rem">
              <span class="help">A fixed number of emails to send per day. Leave empty or 0 to use the automatic warm-up ramp (currently ${quota}/day).</span>
            </label>
            <button style="margin-top:.4rem">Save quota</button>
          </form>
        </details>

        <details class="crit">
          <summary>🔔 Alerts</summary>
          <form method="post" action="/settings/reply-alerts" class="stack" style="margin-top:.4rem">
            <input type="hidden" name="back" value="${esc(backPanel)}">
            <label style="display:flex;align-items:flex-start;gap:.4rem;font-size:.85rem">
              <input type="checkbox" name="enabled" ${replyAlertsOn ? 'checked' : ''} onchange="this.form.submit()">
              <span>Email me the moment a new reply comes in
                <span class="help">Separate from the daily 08:00 summary, which keeps sending either way. New replies always show on the dashboard regardless of this setting.</span>
              </span>
            </label>
          </form>
        </details>

        <details class="crit"${gmailConnected && aiKey.set ? '' : ' open'}>
          <summary>🔗 Connections${gmailConnected && aiKey.set ? '' : ' <span class="fcount">!</span>'}</summary>

          <p class="muted" style="font-size:.82rem;margin:.5rem 0">
            ${gmailConnected
              ? 'Gmail is connected - email can be sent.'
              : `<b style="color:#b45309">Gmail is not connected</b> - no email can be sent until you connect it.${config.google.clientId
                  ? ''
                  : ' Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Railway first.'}`}
          </p>
          ${!gmailConnected && config.google.clientId
            ? `<form method="get" action="/oauth/start"><button class="primary">🔗 Connect Gmail</button></form>
               <div class="muted" style="font-size:.78rem;margin-top:.4rem">In Google Cloud, register this exact Authorized redirect URI: <code>${esc(redirectUri)}</code></div>`
            : ''}

          <p class="muted" style="font-size:.8rem;margin:.8rem 0 .3rem">
            Keys are stored in the database and take effect immediately — no redeploy.
            They are write-only here: once saved, only the last four characters are ever shown again.
            A key saved here overrides the matching Railway variable.
          </p>

          <form method="post" action="/keys" class="stack" style="margin-bottom:.9rem">
            <input type="hidden" name="which" value="anthropic">
            <input type="hidden" name="back" value="${esc(backPanel)}">
            <label style="display:block;font-size:.8rem;color:var(--muted)">
              Anthropic API key — writes the reply to every lead who answers.
              ${aiKey.set
                ? `<b>Connected</b> (${esc(aiKey.hint)}, from ${aiKey.source === 'dashboard' ? 'this dashboard' : 'Railway'}).`
                : '<b style="color:#b45309">Not connected</b> — replies fall back to templates.'}
              Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.
              <input name="key" type="password" autocomplete="off" spellcheck="false"
                     placeholder="${aiKey.set ? 'Saved (' + esc(aiKey.hint) + ') — type a new key to replace it' : 'sk-ant-…'}"
                     style="width:100%;margin-top:.2rem">
            </label>
            <div class="toolgrid">
              <button class="primary">Save key</button>
              ${aiKey.set ? `<button formaction="/keys/test" title="Spends a few tokens on a one-word request to prove the key works">🧪 Test it</button>
                <button formaction="/keys/clear" onclick="return confirm('Remove the saved Anthropic key? Replies will fall back to templates.')">Remove</button>` : ''}
            </div>
            ${aiKey.shadowsEnv ? `<div class="muted" style="font-size:.78rem;margin-top:.4rem">
              Note: <code>ANTHROPIC_API_KEY</code> is also set in Railway but is <b>not</b> being used — the key saved here wins. Remove this one to fall back to it.</div>` : ''}
          </form>

          <form method="post" action="/keys" class="stack">
            <input type="hidden" name="which" value="apify">
            <input type="hidden" name="back" value="${esc(backPanel)}">
            <label style="display:block;font-size:.8rem;color:var(--muted)">
              Apify token <span style="opacity:.8">(optional)</span> — automatic LinkedIn lookup. Costs money per lookup.
              ${apifyKey.set ? `<b>Saved</b> (${esc(apifyKey.hint)}, from ${apifyKey.source === 'dashboard' ? 'this dashboard' : 'Railway'}).` : 'Not set — the 🔍 Find searches still work by hand.'}
              <input name="key" type="password" autocomplete="off" spellcheck="false"
                     placeholder="${apifyKey.set ? 'Saved — type a new token to replace it' : 'apify_api_…'}"
                     style="width:100%;margin-top:.2rem">
            </label>
            <div class="toolgrid">
              <button>Save token</button>
              ${apifyKey.set ? `<button formaction="/keys/clear" onclick="return confirm('Remove the saved Apify token?')">Remove</button>` : ''}
            </div>
            ${apifyKey.shadowsEnv ? `<div class="muted" style="font-size:.78rem;margin-top:.4rem">
              Note: <code>APIFY_TOKEN</code> is also set in Railway but is <b>not</b> being used — the token saved here wins.</div>` : ''}
          </form>
        </details>

        <details class="crit">
          <summary>🔎 Search criteria</summary>
          <p class="muted" style="font-size:.8rem;margin:.5rem 0">Saved to the database; takes effect on the next “Source now” and scheduled refill.</p>
          <form method="post" action="/criteria" class="stack">
            <input type="hidden" name="back" value="${esc(backPanel)}">
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
            <label style="display:flex;align-items:flex-start;gap:.4rem;margin:.4rem 0;font-size:.82rem">
              <input type="checkbox" name="scanReviews" ${crit.scanReviews ? 'checked' : ''} style="margin-top:.2rem">
              <span>Mine reviews for buy-signals (“too expensive”, “should be free”…) — boosts Opportunity, uses more API credits</span>
            </label>
            <label style="display:flex;align-items:flex-start;gap:.4rem;margin:.4rem 0;font-size:.82rem">
              <input type="checkbox" name="enrichFromSite" ${crit.enrichFromSite ? 'checked' : ''} style="margin-top:.2rem">
              <span>Read each studio’s own website for the founder’s name and LinkedIn — free (no API credits), but makes sourcing slower</span>
            </label>
            <button class="primary">Save criteria</button>
            <span class="help">Valid categories: ${criteria.VALID_CATEGORIES.join(', ')}</span>
          </form>
        </details>

        <details class="crit">
          <summary>🧰 Tools</summary>
          <div class="toolgrid">
            <form method="post" action="/test-email"><input type="hidden" name="back" value="${esc(backPanel)}"><button title="Send a test email to your own inbox to verify Gmail works (bypasses DRY, only emails you)">✉ Test to me</button></form>
            <form method="get" action="/duplicates"><button title="Review &amp; merge duplicate leads (same email) — combine their apps into one">🔁 Duplicates${dupCount ? ' (' + dupCount + ')' : ''}</button></form>
            <form method="get" action="/audit"><button title="Find possibly-irrelevant leads (giants, junk) to review and block">🔎 Audit</button></form>
            <form method="get" action="/reviews"><button title="See the actual review quotes behind every 💬 buy-signal badge">💬 Reviews</button></form>
            ${blankNameCount ? `<form method="post" action="/admin/fix-names" onsubmit="return confirm('Fix ${blankNameCount} lead(s) with a blank Studio name?')"><input type="hidden" name="back" value="${esc(backPanel)}"><button class="primary" title="AppStoreSpy returned no developer name for these — fill in the app name or developer ID instead of leaving it blank">🩹 Fix ${blankNameCount} blank name${blankNameCount === 1 ? '' : 's'}</button></form>` : ''}
            ${cov.needs_enrich ? `<form method="post" action="/admin/enrich"><input type="hidden" name="back" value="${esc(backPanel)}"><input type="hidden" name="batch" value="50"><button title="Read up to 50 studio websites for a founder name, a phone number and a LinkedIn link. Free - no API credits - but takes a minute.">🔎 Find people (${cov.needs_enrich})</button></form>` : ''}
          </div>
          <div class="toolgrid" style="margin-top:.8rem;border-top:1px solid var(--line);padding-top:.6rem">
            <form method="post" action="/admin/clear" onsubmit="return confirm('Delete ALL leads and events? This cannot be undone.')"><input type="hidden" name="back" value="${esc(backPanel)}"><button title="Delete all leads to start fresh">🗑 Clear all leads</button></form>
          </div>
        </details>

        <details class="crit">
          <summary>ℹ️ What do these columns &amp; filters mean?</summary>
          <div style="margin-top:.6rem;font-size:.82rem;line-height:1.7">
            <b>Opp (Opportunity Score, 0–100):</b> how good an acquisition target this app is — high demand (rating, reviews, installs) combined with weak monetization (low/no revenue, no ads/IAP) and signs it's cheap to buy (solo dev, no website, few apps). Higher is better. This is what the list is sorted by.<br>
            <b>Priority:</b> installs/day × total apps published by this developer. It is a raw "how big is this developer" number, used only as a tie-breaker after Opportunity — a high Priority is <i>not</i> a good sign by itself (Google/Samsung score millions here); use "Priority max" in filters to hide giants.<br>
            <b>Total inst / Inst/day:</b> all-time installs of this specific app, and the developer's current daily install velocity (still-alive demand).<br>
            <b>Rev/mo, $/inst:</b> the app's estimated monthly revenue, and revenue per install (low = weak monetization = upside).<br>
            <b>💬 badge:</b> number of reviews found complaining about price/ads or offering to pay — open <b>👁 Preview</b> on that lead to read the actual quotes.<br>
            <b>Site:</b> 🌐 is the studio's own website. It comes from Google Play when listed; otherwise it is inferred from the privacy-policy link or the email domain. A dash means we found nothing, which is itself a solo-dev signal (the score only counts a website Google Play actually listed).<br>
            <b>Contact:</b> the person behind the app. <b>✅</b> means the name was read off the studio's own website and is reliable. <b>~</b> means it was split out of the email address (jane.doe@… → Jane Doe) and is a <i>guess</i> — never address someone by a ~ name without checking. Outreach emails deliberately keep using the studio name.<br>
            <b>Phone:</b> a number the studio published <i>as</i> a phone number — a tap-to-call link or a "Phone:"/"Tel:" line on their own site, or the store listing's developer contact. Tap it to call. There is deliberately no digit-scraping fallback: a page is full of digit runs (company and VAT numbers, dates, postcodes), and a wrong number here means calling a stranger. A dash means they published none.<br>
            <b>Country:</b> where the studio is based, from AppStoreSpy. Its job is to narrow down a common name on LinkedIn.<br>
            <b>Response status:</b> "Respond" is set automatically on their first reply. Everything after that is set by
            hand as the conversation moves: <b>Booked a call</b>, <b>Reviewing Data</b> (they gave us access and we are going
            through their numbers), <b>Negotiating Price</b>, <b>Too Expensive</b> (they pushed back on the number),
            <b>Maybe in the Future</b> (not now, worth another look down the line), <b>Not Relevant</b>, or <b>No Response</b>
            (closed out after both follow-ups with silence).
            Setting <b>Booked a call</b>, <b>Reviewing Data</b> or <b>Negotiating Price</b> also stops the green
            "waiting on you" banner from nagging about that lead — the conversation is already moving, so a stray message
            is folded into one muted summary line instead of its own card. Setting <b>Too Expensive</b>,
            <b>Not Relevant</b> or <b>No Response</b> stops it completely — that deal is finished, so a message afterward
            gets no mention there at all. Either way it still shows the red NEEDS REPLY stripe in the list.<br>
            <b>Asking Price / Our Price:</b> plain numbers you type in as a negotiation moves — what the studio is asking,
            and the number we've offered or are prepared to. Not sourced from anywhere; saves as soon as you leave the
            field. Blank means nothing has been discussed yet.<br>
            <b>The tiles at the top are clickable</b> — each one filters the table to exactly the leads it counted, and "← Back to all" clears it.<br>
            <b>Filter chips:</b> every filter you apply appears as a chip under the search box — click its × to remove just that one.<br>
            <b>Sorting:</b> click any column header to sort by it (▲/▼ shows the active one and direction); click again to flip direction. This combines with whatever filters and search are already applied.<br>
            <b>LI Link:</b> the verified LinkedIn URL itself, spelled out - only filled in when one was actually found on the studio's own site (same case as the blue LinkedIn icon). Use "LinkedIn: Verified" in More column filters to list only those.<br>
            <b>Contact coverage right now:</b> ${cov.total} lead${cov.total === 1 ? '' : 's'} —
            ${cov.with_site} with a website, ${cov.with_name} with a contact name
            (${cov.name_verified} of those verified from the studio site),
            ${cov.with_linkedin} with a LinkedIn URL, ${cov.with_phone} with a phone, ${cov.with_country} with a country.
            Check these numbers before paying for external enrichment: if the free steps already cover most leads, there is nothing to buy.<br>
            <b>LinkedIn:</b> a <span style="color:#0A66C2;font-weight:600">blue</span> icon is a real link — a profile or company page the studio published on its own website, found while reading their site. A <span class="muted" style="font-weight:600">grey</span> icon means nothing was found there, and opens ready-made <i>searches</i> for this lead — by name + studio, by name + country, by app name (developers often list their own app in their profile), and by studio + role. Those are searches, not verified profiles: you pick the right person.<br>
            <b>View:</b> quick presets (e.g. "Queue" = never contacted yet). <b>Search:</b> matches Studio/App/Category/Email. <b>OS:</b> Android vs iOS (only Android is sourced today).
          </div>
        </details>`;

      res.send(shell(`
        <header>
          <h1>${esc(config.brand.companyName)} Utility Outreach</h1>
          ${mode} ${sendPill} ${gmailPill}
          <div class="toolbar">
            <form method="post" action="/run/refill"><button class="primary" title="Fetch new utility-app studios from AppStoreSpy using the search criteria in Settings, screen them, and add them as leads">Source now</button></form>
            <form method="post" action="/run/send"><button title="Send one paced batch now to leads in the queue — respects the daily quota, the send window, and DRY/LIVE mode">Send tick</button></form>
            <form method="post" action="/run/watch"><button title="Scan the inbox now for replies and bounces and update lead statuses">Check replies</button></form>
            <a href="${esc(backPanel)}" data-side="open" title="Sending mode, API keys, search criteria and tools"><button type="button">⚙ Settings</button></a>
          </div>
        </header>

        ${msg ? `<div class="banner">${msg}</div>` : ''}

        ${bannerWaiting.length ? `<div class="banner" style="border-color:#10b981;background:#dcfce7;color:#065f46">
          🎉 <b>${bannerWaiting.length} conversation${bannerWaiting.length === 1 ? '' : 's'} waiting on you.</b>
          <a href="/?view=replied" style="margin-left:.5rem;font-weight:600">Show them →</a>
          <span style="opacity:.8">Newest first. ${awaitingCount ? `<b>${awaitingCount}</b> wrote again after your answer.` : ''}</span>
          ${bannerWaiting.slice(0, 6).map((l) => {
            // bannerWaiting has already dropped the leads the AI cleared AND
            // who haven't written again since our last answer - see its
            // definition above. What's left here still needs the softer
            // treatment for the ones the AI cleared but kept (they wrote
            // again, the stronger "still waiting" signal): swap the bold CTA
            // for a muted pill instead of hiding them.
            const noActionNeeded = l.ai_action_needed === 'no';
            return `
            <div style="margin-top:.5rem;padding:.5rem .7rem;background:#ffffff88;border-radius:8px">
              <b>${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener" title="Open the studio's own website">${esc(l.name)}</a>` : esc(l.name)}</b>
              ${l.top_app ? ` · ${appCell(l)}` : ''}
              ${l.reply_subject ? ` <span style="opacity:.7">— ${esc(l.reply_subject)}</span>` : ''}
              ${l.awaitingUs ? '<span class="pill" style="background:#fee2e2;color:#991b1b;border-color:#fca5a5;margin-left:.4rem;font-size:.68rem">↩ replied after you</span>' : ''}
              ${Number(l.reply_count) > 1 ? `<span class="muted" style="font-size:.72rem;margin-left:.4rem">${l.reply_count} messages</span>` : ''}
              <span class="muted" style="font-size:.72rem;margin-left:.4rem">${esc(agoLabel(l.last_inbound_at))}</span>
              <span style="display:inline-block;margin-left:.4rem;vertical-align:middle">${selectCell(l.id, 'response', RESPONSE_OPTS, l.response, backHere)}</span>
              ${noActionNeeded
                ? `<span class="pill" style="background:#f1f5f9;color:#475569;border-color:#cbd5e1;margin-left:.4rem;font-size:.68rem" title="${esc(l.ai_action_reason)}">✓ probably no reply needed</span>
                   <a href="/reply/${l.id}${backQS}" style="margin-left:.4rem">Draft a reply anyway →</a>`
                : `<a href="/reply/${l.id}${backQS}" style="margin-left:.4rem;font-weight:600">✍️ Draft a reply →</a>`}
              ${l.reply_thread ? `<a href="https://mail.google.com/mail/u/0/#inbox/${esc(l.reply_thread)}" target="_blank" rel="noopener" style="margin-left:.4rem">open in Gmail →</a>` : ''}
              ${l.ai_summary ? `<div class="muted" style="font-size:.78rem;margin-top:.3rem">🧠 ${esc(l.ai_summary)}${noActionNeeded && l.ai_action_reason ? ' <i>— ' + esc(l.ai_action_reason) + '</i>' : ''}</div>` : ''}
              <div style="opacity:.85;font-style:italic;margin-top:.2rem">“${esc(l.reply_snippet)}”</div>
            </div>`;
          }).join('')}
          ${quietCount ? `<div class="muted" style="margin-top:.5rem;font-size:.8rem">
            ${quietCount} more with a booked call / data review / price talk also wrote - not counted above,
            because that conversation is already moving. <a href="/?view=booked">Show them →</a>
          </div>` : ''}
        </div>` : ''}

        ${!gmailConnected ? `<div class="banner">📧 <b>Gmail is not connected</b> — no email can be sent until you connect it.
          ${config.google.clientId
            ? `<a href="${esc(backPanel)}" data-side="open" style="margin-left:.5rem;font-weight:600">Connect it in ⚙ Settings →</a>`
            : ' Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Railway first (see setup).'}
        </div>` : ''}

        <div class="status">
          <span>Window: <b>${wOpen ? 'OPEN' : 'closed'}</b> (${config.sender.windowStartHour}:00–${config.sender.windowEndHour}:00, Mon–Fri)</span>
          <span title="Change the daily quota in ⚙ Settings → Sending">Sent today: <b>${sentToday}</b> / ${quota}</span>
          ${dupCount ? `<span>Duplicates: <b>${dupCount}</b> <a href="/duplicates">review →</a></span>` : ''}
          <span id="nexttick" data-mode="${sendMode}" data-dry="${dry ? '1' : '0'}">…</span>
          <span id="replytick" data-last="${esc(lastWatchRun)}" title="${esc(lastWatchStatus)}">…</span>
        </div>

        <div class="tiles">${TILES.map(tile).join('')}</div>
        ${tileView ? `<div class="banner" style="margin:-.6rem 0 1rem;padding:.45rem .7rem;font-size:.85rem">
          Showing <b>${tileCounts[view]}</b> ${esc(tileView.label.toLowerCase())} lead${tileCounts[view] === 1 ? '' : 's'}.
          <a href="/" style="margin-left:.5rem;font-weight:600">← Back to all</a>
        </div>` : ''}

        <form id="bulkform" method="post" action="/bulk"><input type="hidden" name="back" value="${esc(backHere)}"></form>
        <div class="bulkbar" hidden>
          <span class="bulkcount">0 selected</span>
          <button form="bulkform" name="action" value="block" onclick="return confirm('Block the selected leads?')" title="Move every checked row to the Block List — never contacted again">⛔ Block selected</button>
          <button form="bulkform" name="action" value="delete" onclick="return confirm('Delete the selected leads permanently?')" title="Permanently delete every checked row">🗑 Delete selected</button>
        </div>

        <div class="filters">
          <form method="get" action="/" id="filterform">
            <div class="bar">
              <label class="search" title="Free-text search across Studio, App name, Category, and Email">
                <input name="q" value="${esc(f.q)}" placeholder="Search studio, app, category, email…">
              </label>
              <label title="Quick presets: which leads to show based on their group/status">View:
                <select name="view" onchange="this.form.submit()" title="Quick presets: which leads to show based on their group/status">
                  ${[['nonblocked', 'Hide blocked'], ['all', 'All'], ['queue', 'Queue (not contacted)'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['booked', 'Booked calls'], ['negotiating', 'Negotiating Price'], ['expensive', 'Too Expensive'], ['maybe', 'Maybe in the Future'], ['blocked', 'Blocked only']]
                    .map(([v, l]) => `<option value="${v}"${view === v ? ' selected' : ''}>${l}</option>`).join('')}
                </select>
              </label>
              <label title="Filter to only Android or only iOS leads">OS: <select name="platform" onchange="this.form.submit()" title="Filter to only Android or only iOS leads">
                <option value=""${!f.platform ? ' selected' : ''}>All</option>
                <option value="android"${f.platform === 'android' ? ' selected' : ''}>🤖 Android</option>
                <option value="ios"${f.platform === 'ios' ? ' selected' : ''}>🍎 iOS</option>
              </select></label>
              <button type="submit" title="Apply the search box + OS filter above">Apply filters</button>
              <span class="seg">
                <button type="button" data-selectall="1" title="Tick every row currently shown (respects the active filters) - one click, not one at a time">☑️ Select all shown</button>
                <button type="button" data-selectall="0" title="Untick every row">☐ Clear selection</button>
              </span>
              <button type="button" id="copyTableBtn" title="Copy the ticked rows, or every visible row if none are ticked, as tab-separated text - paste directly into a spreadsheet">📋 Copy table</button>
              <button type="button" id="exportTableBtn" title="Download the ticked rows, or every visible row if none are ticked, as a .csv file - opens straight into Excel">⬇️ Export to Excel</button>
              <span class="muted">Showing ${shown.length} of ${leads.length} leads</span>
            </div>
            <details class="crit" style="margin-top:.5rem"${advCount ? ' open' : ''}>
              <summary>🎛 More column filters (Opportunity, Installs, Rating, Revenue, Apps, Priority, Category, Country, Site, Contact, Phone, LinkedIn, Asking/Our price, Outreach/Response)${advCount ? ` <span class="fcount">${advCount}</span>` : ''}</summary>
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
                <label title="Only show apps with at least this many installs/day (current velocity, not all-time)">Inst/day min<input name="f_instDayMin" value="${esc(f.instDayMin || '')}"></label>
                <label title="Only show apps with at most this many installs/day">Inst/day max<input name="f_instDayMax" value="${esc(f.instDayMax || '')}"></label>
                <label title="Only show leads earning at most this much revenue per install — low means weak monetization (upside for acquisition)">$/inst max<input name="f_rpiMax" value="${esc(f.rpiMax || '')}"></label>
                <label title="Only show leads in this Google Play category">Category<select name="f_category">
                  <option value=""${!f.category ? ' selected' : ''}>Any</option>
                  ${criteria.VALID_CATEGORIES.map((c) => `<option value="${esc(c)}"${c === f.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}
                </select></label>
                <label title="Only show leads whose Country contains this text (case-insensitive)">Country contains<input name="f_country" value="${esc(f.country || '')}" placeholder="e.g. Germany"></label>
                <label title="Only show leads whose Group contains this text — Group is the internal send-cohort tag, not a status">Group contains<input name="f_group" value="${esc(f.group || '')}"></label>
                <label title="Only show leads that do/do not have a website listed">Website<select name="f_site">
                  <option value=""${!f.site ? ' selected' : ''}>Any</option>
                  <option value="yes"${f.site === 'yes' ? ' selected' : ''}>Has website</option>
                  <option value="no"${f.site === 'no' ? ' selected' : ''}>No website</option>
                </select></label>
                <label title="Only show leads that do/do not have a phone number published">Phone<select name="f_phone">
                  <option value=""${!f.phone ? ' selected' : ''}>Any</option>
                  <option value="yes"${f.phone === 'yes' ? ' selected' : ''}>Has phone</option>
                  <option value="no"${f.phone === 'no' ? ' selected' : ''}>No phone</option>
                </select></label>
                <label title="✅ verified = read off the studio's own site. ~ guessed = split from the email address. Filter separates the two, same as the Contact column's marks.">Contact name<select name="f_contact">
                  <option value=""${!f.contact ? ' selected' : ''}>Any</option>
                  <option value="verified"${f.contact === 'verified' ? ' selected' : ''}>✅ Verified (from site)</option>
                  <option value="guessed"${f.contact === 'guessed' ? ' selected' : ''}>~ Guessed (from email)</option>
                  <option value="none"${f.contact === 'none' ? ' selected' : ''}>None found</option>
                </select></label>
                <label title="A blue LinkedIn icon (Verified) is a profile the studio published on its own site — a real link. A grey one (Search only) means nothing was found, only ready-made search suggestions.">LinkedIn<select name="f_linkedin">
                  <option value=""${!f.linkedin ? ' selected' : ''}>Any</option>
                  <option value="verified"${f.linkedin === 'verified' ? ' selected' : ''}>🔗 Verified (found on their site)</option>
                  <option value="search"${f.linkedin === 'search' ? ' selected' : ''}>Search only (not found)</option>
                </select></label>
                <label title="Only show leads whose asking price is at or above this">Asking price min ($)<input name="f_askMin" value="${esc(f.askMin || '')}"></label>
                <label title="Only show leads whose asking price is at or below this">Asking price max ($)<input name="f_askMax" value="${esc(f.askMax || '')}"></label>
                <label title="Only show leads where our offered price is at or above this">Our price min ($)<input name="f_offMin" value="${esc(f.offMin || '')}"></label>
                <label title="Only show leads where our offered price is at or below this">Our price max ($)<input name="f_offMax" value="${esc(f.offMax || '')}"></label>
              </div>
              <p><button type="submit" title="Apply all the column filters above">Apply filters</button></p>
            </details>
          </form>
          ${anyFilterActive ? `<div class="chips">
            ${activeChips.map((c) => `<span class="chip">${esc(c.label(qp[c.k]))} <a href="${esc(urlWith(c.k, null))}" title="Remove this filter">✕</a></span>`).join('')}
            <a href="/" style="font-size:.78rem;font-weight:600" title="Remove every active filter and show the default view">Clear all</a>
          </div>` : ''}
        </div>
        <p class="legend wide-only">The <b>Studio</b> and <b>Actions</b> columns stay pinned; scroll the table sideways for status &amp; details.</p>
        <div class="cards">${cards || '<p class="muted">No leads yet — click "Source now".</p>'}</div>
        <div class="card wrap"><table id="leadsTable">
          <thead><tr>
            ${th('name', 'Studio')}${th('app', 'App')}${th('os', 'OS', '🤖 Android or 🍎 iOS')}${th('opp', 'Opp', 'Acquisition Opportunity Score (0–100): demand × weak monetization × how cheap/easy to acquire. Sorted high to low by default.')}${th('category', 'Category')}
            ${th('instday', 'Inst/day', "Developer's current installs/day (install velocity)")}${th('insttotal', 'Total inst', "This app's all-time installs")}
            ${th('apps', 'Apps', 'Number of apps this developer has published')}${th('rev', 'Rev/mo', "This app's estimated revenue per month")}${th('rpi', '$/inst', 'Revenue per install — low means weak monetization (upside for acquisition)')}
            ${th('rating', 'Rating', "This app's Google Play rating (0–5) and number of ratings")}
            ${th('priority', 'Priority', "Installs/day × total apps for this developer. A raw 'how big' number, NOT a quality signal — Google/Samsung score in the billions here. Used only to break ties after Opportunity; filter it out with 'Priority max'.")}
            ${th('email', 'Email')}<th>Store</th>${th('site', 'Site', "The studio's own website, when Google Play lists one. Blank is itself a signal — solo devs often have none.")}
            ${th('contact', 'Contact', "The person behind the app. ✅ was read off the studio's own site; ~ was guessed from the email address and is unverified.")}
            ${th('phone', 'Phone', "A phone number the studio published itself - a tap-to-call link or a Phone: line on their site, or the store's developer contact. Tap it to call. Nothing is guessed from digits on a page.")}
            ${th('country', 'Country', 'Where the studio is based (AppStoreSpy hq_country). Narrows down a common name on LinkedIn.')}
            ${th('linkedin', 'LinkedIn', 'A blue LinkedIn icon is a profile the studio published on its own website — a real link. A grey one opens ready-made searches instead, because nothing was found: those are searches, not verified profiles.')}
            ${th('linkedin', 'LI Link', "The verified LinkedIn URL itself, when one was found on the studio's own site - the same profile as the LinkedIn column, shown as a link you can open or copy directly. Blank means nothing was found there yet.")}
            ${th('asking', 'Asking Price', 'What the studio is asking for the app. Set by hand as the negotiation moves - not sourced from any API. Click to edit.')}
            ${th('offer', 'Our Price', "The number we've offered or are prepared to offer. Set by hand. Click to edit.")}
            ${th('outreach', 'Outreach status')}${th('response', 'Response status')}<th title="What the lead actually wrote back (hover for more, or open the thread in Gmail)">Reply</th>${th('group', 'Group')}<th></th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="${COLUMN_COUNT}" class="muted">No leads yet — click “Source now”.</td></tr>`}</tbody>
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
      `, sidePanel, sideOpen, closeHref));
    } catch (e) {
      res.status(500).send('Error: ' + esc(e.message));
    }
  });

  app.post('/action/:id/set', async (req, res) => {
    const patch = {};
    if ('outreach' in req.body) patch.outreach = String(req.body.outreach);
    if ('response' in req.body) patch.response = String(req.body.response);
    // Negative and non-numeric input clear the field back to unset (0), same
    // as leaving the box empty - there is no such thing as a negative price.
    for (const field of ['asking_price', 'offer_price']) {
      if (field in req.body) {
        const n = Number(req.body[field]);
        patch[field] = Number.isFinite(n) && n > 0 ? n : 0;
      }
    }
    if (Object.keys(patch).length) await db.updateLead(Number(req.params.id), patch);
    res.redirect(backUrl(req));
  });
  app.post('/action/:id/block', async (req, res) => {
    await db.updateLead(Number(req.params.id), { grp: config.groups.blockList });
    res.redirect(backUrl(req));
  });
  app.post('/action/:id/delete', async (req, res) => {
    try { await db.deleteLead(Number(req.params.id)); return back(res, 'Lead deleted.'); }
    catch (e) { return back(res, '⚠️ Delete failed: ' + e.message); }
  });
  app.post('/bulk', async (req, res) => {
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    // Every lead's checkbox renders twice (mobile card + table row), so the
    // same id arrives twice per ticked lead - dedupe or "3 selected" reports
    // as "Blocked 6".
    ids = [...new Set(ids.map(Number).filter(Boolean))];
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
  // Returns to wherever the form/link that got here carried in its "back"
  // field - the filtered/searched list you were on, not always the default
  // view. res.req is Express's own back-reference to the request, so every
  // existing back(res, msg) call site keeps working unchanged.
  const back = (res, m) => {
    const dest = backUrl(res.req);
    res.redirect(dest + (dest.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(m));
  };

  // Preview the exact email that would be sent next to a lead.
  app.get('/preview/:id', async (req, res) => {
    try {
      const dry = await liveMode.isDry();
      const leads = await db.allLeads();
      const lead = leads.find((l) => String(l.id) === String(req.params.id));
      if (!lead) return res.status(404).send('Lead not found');
      // Wherever the filtered/searched list was that got here - "Back to list"
      // must return to it, not reset to the unfiltered default.
      const backTo = safeBack(req.query.back) || '/';
      const S = config.statuses;
      let step, subject, html;
      if (!lead.outreach) { step = 'Initial'; const tp = templates.initial(lead); subject = tp.subject; html = tp.html; }
      else if (lead.outreach === S.emailSent) { step = 'Follow-up 1'; subject = 'Re: Quick question about ' + lead.name; html = templates.fu1(lead).html; }
      else if (lead.outreach === S.fu1Sent) { step = 'Follow-up 2'; subject = 'Re: Quick question about ' + lead.name; html = templates.fu2(lead).html; }
      else { step = 'Done'; }

      if (step === 'Done') {
        return res.send(shell(`<p><a href="${esc(backTo)}">← Back</a></p><div class="banner">Sequence is complete for <b>${esc(lead.name)}</b> — no further email will be sent.</div>`));
      }
      res.send(shell(`
        <p><a href="${esc(backTo)}">← Back to list</a></p>
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
            <div><b>Phone:</b> ${lead.phone
              ? `<a href="tel:${esc(people.normalisePhone(lead.phone))}">${esc(lead.phone)}</a>
                 <span class="muted" style="font-size:.8rem">- ${lead.phone_source === 'store' ? 'the store listing\'s developer contact' : 'published on their own website'}</span>`
              : '<span class="muted">none published</span>'}</div>
            <div><b>Website:</b> ${lead.website ? `<a href="${esc(lead.website)}" target="_blank" rel="noopener">${esc(lead.website)}</a>` : '<span class="muted">none</span>'}</div>
            <div><b>LinkedIn:</b> ${lead.linkedin_url
              ? `<a class="li li-on" href="${esc(lead.linkedin_url)}" target="_blank" rel="noopener" style="gap:.3rem">${liIcon(15)} ${esc(lead.linkedin_url.replace(/^https?:\/\/(www\.)?/, ''))}</a>
                 <span class="muted" style="font-size:.8rem">- linked from their own website</span>`
              : '<span class="muted">nothing found on their site - use a search below</span>'}</div>
          </div>
          ${(() => {
            const searches = people.linkedinSearches({
              contactName: lead.contact_name, studio: lead.name, appName: lead.top_app, country: lead.country
            });
            if (!searches.length) return '';
            return `<div style="margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--line)">
              <div class="muted" style="font-size:.8rem;margin-bottom:.3rem">Search LinkedIn - each angle finds a different kind of match, and you decide which hit is the right person:</div>
              ${searches.map((s) => `<div style="margin:.2rem 0"><a class="li li-off" href="${esc(s.url)}" target="_blank" rel="noopener" style="gap:.3rem">${liIcon(14)} ${esc(s.label)}</a> <span class="muted" style="font-size:.78rem">- ${esc(s.why)}</span></div>`).join('')}
            </div>`;
          })()}
          <div style="margin-top:.7rem">
            <form method="post" action="/action/${lead.id}/linkedin">
              <input type="hidden" name="back" value="${esc(backTo)}">
              <button title="Look the profile up automatically through Apify (searches Google's index of public LinkedIn profiles). Costs money per lookup, so use it on leads you actually intend to contact.">🔗 Look up LinkedIn automatically</button>
            </form>
          </div>
        </div>
        <p style="margin-top:1rem">
          <form method="post" action="/action/${lead.id}/send" onsubmit="return confirm('Send this email now?')">
            <input type="hidden" name="back" value="${esc(backTo)}">
            <button class="send" title="Send this exact email now (respects DRY/LIVE mode)">✉ Send this now</button>
          </form>
          <a href="${esc(backTo)}" style="margin-left:.6rem">Cancel</a>
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
    res.redirect(backUrl(req));
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
      // Wherever the filtered/searched list was that got here - every link and
      // form on this page carries it forward, so "Back to list" (and Cancel,
      // and Send) return there instead of resetting to the unfiltered default.
      const backTo = safeBack(req.query.back) || '/';

      // Read the real conversation from Gmail. The watcher only stores a
      // 500-char snippet, which is not enough to answer a long reply properly.
      let thread = [];
      if (lead.reply_thread || lead.thread_id) {
        try { thread = await email.fetchThread(lead.reply_thread || lead.thread_id); }
        catch (e) { thread = []; }
      }

      // The thread itself is the authority on who spoke last. Opening the page
      // repairs a lead that looks unanswered only because the reply went out
      // from Gmail rather than from here.
      const lastMsg = thread[thread.length - 1];
      if (lastMsg && lastMsg.fromUs) {
        const at = Date.parse(lastMsg.date || '') || Date.now();
        const iso = new Date(at).toISOString();
        if (iso > String(lead.last_outbound_at || '')) {
          try { await db.updateLead(lead.id, { last_outbound_at: iso }); lead.last_outbound_at = iso; }
          catch (e) { /* cosmetic - never block the page on it */ }
        }
      }

      const aiOn = await ai.isEnabled();
      // Render immediately with the instant rule-based draft. The Claude call
      // takes tens of seconds, and blocking the page on it meant staring at a
      // blank tab; the browser fetches the AI draft afterwards and swaps it in.
      const wantsAsyncAI = aiOn && wantAI;
      const d = await replydraft.draftSmart({
        lead, thread, intentOverride: chosen, instruction,
        useAI: wantsAsyncAI ? false : wantAI
      });
      const dry = await liveMode.isDry();
      const guard = screenReason({ name: lead.name, email: lead.email, notes: lead.notes, topApp: lead.top_app });

      const options = replydraft.intents().map((i) =>
        `<option value="${esc(i.intent)}" ${i.intent === d.intent ? 'selected' : ''}>${esc(i.label)}</option>`).join('');

      res.send(shell(`
        <p><a href="${esc(backTo)}">← Back to list</a></p>
        <h1 style="font-size:1.2rem">Reply to ${esc(lead.name)}</h1>

        <div class="card" style="padding:1rem;max-width:820px">
          <b>💬 The conversation${thread.length ? ` <span class="muted" style="font-weight:400">(${thread.length} message${thread.length === 1 ? '' : 's'}, oldest first)</span>` : ''}</b>
          ${lead.reply_subject ? `<div class="muted" style="margin-top:.3rem">${esc(lead.reply_subject)}</div>` : ''}
          <div class="thread" style="margin-top:.5rem;padding-right:.2rem">
            ${thread.length
              ? thread.map((m, i) => {
                  const last = i === thread.length - 1;
                  return `<div style="margin:.45rem 0;padding:.6rem .75rem;border-radius:10px;line-height:1.6;
                    background:${m.fromUs ? 'var(--chip)' : 'var(--panel)'};
                    border:1px solid ${last && !m.fromUs ? '#10b981' : 'var(--line)'};
                    ${m.fromUs ? 'margin-left:2.5rem' : 'margin-right:2.5rem'}">
                    <div class="muted" style="font-size:.72rem;margin-bottom:.25rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                      <span>${m.fromUs ? '↗ You' : '↩ ' + esc(lead.name)}${m.date ? ' · ' + esc(m.date) : ''}</span>
                      ${last && !m.fromUs ? '<b style="color:#059669">latest — the draft answers this</b>' : ''}
                      ${!m.fromUs && aiOn ? `<button type="button" class="tmsg" data-i="${i}">🌐 Translate</button>` : ''}
                    </div>
                    <div class="msgtext" data-i="${i}" style="white-space:pre-wrap">${esc(m.text)}</div>
                  </div>`;
                }).join('')
              : (lead.reply_snippet
                ? `<div style="padding:.6rem .75rem;background:var(--panel);border:1px solid var(--line);border-radius:10px;font-style:italic">${esc(lead.reply_snippet)}
                   <div class="muted" style="font-style:normal;font-size:.75rem;margin-top:.3rem">Only the captured preview — the full thread could not be read from Gmail.</div></div>`
                : '<span class="muted">Nothing was captured. Open the thread in Gmail and read it there.</span>')}
          </div>
          ${lead.reply_thread ? `<div style="margin-top:.5rem"><a href="https://mail.google.com/mail/u/0/#inbox/${esc(lead.reply_thread)}" target="_blank" rel="noopener">Open the full thread in Gmail →</a>
            </div>` : ''}
        </div>

        <form method="get" action="/reply/${lead.id}" class="card stack" style="padding:1rem;max-width:820px;margin-top:1rem">
          <input type="hidden" name="back" value="${esc(backTo)}">
          <b>🎯 How this was written</b>
          ${wantsAsyncAI ? `<div id="aistate" class="muted" style="font-size:.85rem;margin:.3rem 0 .6rem">
            <span style="color:#0A66C2;font-weight:600">✨ Claude is writing a reply…</span>
            you can start editing the draft below now — it will be replaced when Claude is done.
          </div>` : ''}
          <div class="muted" style="font-size:.85rem;margin:.3rem 0 .6rem"${wantsAsyncAI ? ' hidden id="aifallbackline"' : ''}>
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
          <input type="hidden" name="back" value="${esc(backTo)}">
          <b>✍️ Your reply</b>
          <div class="muted" style="font-size:.8rem;margin:.3rem 0 .6rem">
            To ${esc(lead.email)} - goes into the same Gmail thread. Write it as a normal email;
            bullet lines starting with <code>-</code> or <code>1.</code> become proper lists.
          </div>
          <label style="display:block;font-size:.8rem;color:var(--muted)">Subject
            <input name="subject" value="${esc(d.subject)}" style="width:100%;margin-top:.2rem">
          </label>
          ${aiOn ? `<div class="aitools" style="margin-top:.7rem">
            <span class="muted" style="font-size:.75rem">Rewrite</span>
            <select id="t-scope" title="Every tool here applies to whatever this says. Highlight text in the draft and it switches to your selection by itself.">
              <option value="all">the whole reply</option>
              <option value="sel" disabled>the selection</option>
            </select>
            <span class="muted" style="font-size:.75rem">:</span>
            <select id="t-tone"><option value="">Tone…</option>${
              Object.keys(ai.TONES).map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('')
            }</select>
            <button type="button" data-kind="length" data-option="shorter">Shorter</button>
            <button type="button" data-kind="length" data-option="longer">Longer</button>
            <select id="t-lang"><option value="">Language…</option>${
              ['English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian', 'Dutch', 'Polish',
                'Russian', 'Turkish', 'Arabic', 'Hebrew', 'Hindi', 'Indonesian', 'Vietnamese',
                'Chinese', 'Japanese', 'Korean'].map((l) => `<option>${l}</option>`).join('')
            }</select>
            <button type="button" id="t-sel" data-kind="rephrase" disabled
              title="Highlight a sentence in the draft, then click this to reword just that part">✏️ Reword</button>
            <input id="t-custom" placeholder="or tell it what to change…" style="min-width:180px">
            <button type="button" id="t-go">Apply</button>
            <span id="t-state" class="muted" style="font-size:.78rem"></span>
          </div>
          <div class="aitools" style="border-top:0;border-radius:0 0 8px 8px;margin-top:-1px">
            <button type="button" id="h-undo" disabled title="Go back to the previous version of this draft">↶ Back</button>
            <button type="button" id="h-redo" disabled title="Go forward again">↷ Forward</button>
            <span id="h-state" class="muted" style="font-size:.78rem"></span>
            <span id="h-trail" class="muted" style="font-size:.72rem;margin-left:auto"></span>
          </div>` : ''}
          <textarea name="text" rows="24" spellcheck="true"
            style="width:100%;margin-top:.7rem;padding:.7rem;border:1px solid var(--line);border-radius:8px;
                   background:var(--bg);color:var(--ink);font:inherit;line-height:1.6;resize:vertical"
          >${esc(d.text)}</textarea>
          ${guard ? `<div class="banner" style="margin:.6rem 0">⚠️ This lead trips a guard: <b>${esc(guard)}</b>. Sending is blocked.</div>` : ''}
          <div style="margin-top:.7rem;display:flex;gap:.6rem;align-items:center">
            <button class="send" ${guard ? 'disabled' : ''}>✉ Send reply${dry ? ' (dry run - nothing will leave)' : ''}</button>
            <a href="${esc(backTo)}">Cancel</a>
          </div>
        </form>

        ${aiOn ? `<script>
        (function(){
          var LEAD = ${lead.id};
          var box = document.querySelector('textarea[name=text]');
          var state = document.getElementById('t-state');
          var selBtn = document.getElementById('t-sel');
          var tone = document.getElementById('t-tone');
          var lang = document.getElementById('t-lang');
          var custom = document.getElementById('t-custom');
          var scope = document.getElementById('t-scope');
          var scopeSel = scope.querySelector('option[value=sel]');

          function busy(on, what){
            state.textContent = on ? ('✨ ' + what + '…') : '';
            document.querySelectorAll('.aitools button, .aitools select, .aitools input')
              .forEach(function(el){ el.disabled = on; });
            if(!on){ syncSel(); paintHistory(); }
          }
          function post(body){
            return fetch('/reply/' + LEAD + '/transform', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            }).then(function(r){ return r.json(); });
          }

          /* ---- version history --------------------------------------------
             Every AI change replaces the whole box, which wipes the browser's
             own undo stack - so we keep our own. Entries are labelled, because
             "back to the version before I made it shorter" is what you actually
             want, not an anonymous undo. */
          var hist = [{ text: box.value, label: ${JSON.stringify(d.source === 'ai' ? "Claude's draft" : 'Template draft')} }];
          var hpos = 0;
          var undoBtn = document.getElementById('h-undo');
          var redoBtn = document.getElementById('h-redo');
          var hState = document.getElementById('h-state');
          var hTrail = document.getElementById('h-trail');

          function paintHistory(){
            undoBtn.disabled = hpos <= 0;
            redoBtn.disabled = hpos >= hist.length - 1;
            hState.textContent = hist.length > 1
              ? 'version ' + (hpos + 1) + ' of ' + hist.length + ' · ' + hist[hpos].label
              : hist[0].label;
            var from = Math.max(0, hist.length - 5);
            hTrail.textContent = hist.length > 1
              ? (from ? '… → ' : '') + hist.slice(from).map(function(h, i){
                  return (from + i) === hpos ? '[' + h.label + ']' : h.label;
                }).join(' → ')
              : '';
          }
          // Typing after a generated version is itself a version worth keeping,
          // otherwise going Back would silently throw away what you wrote.
          function captureEdit(){
            if(box.value !== hist[hpos].text){
              hist = hist.slice(0, hpos + 1);
              hist.push({ text: box.value, label: 'your edit' });
              hpos = hist.length - 1;
            }
          }
          function push(text, label){
            captureEdit();
            hist = hist.slice(0, hpos + 1);          // a new branch drops the redo tail
            hist.push({ text: text, label: label });
            hpos = hist.length - 1;
            box.value = text;
            paintHistory();
          }
          // A step, not an index: captureEdit may append the operator's typing
          // and move hpos, so a target worked out before that runs is stale -
          // which landed you one version short of your own text on the way back.
          function step(delta){
            captureEdit();                            // never lose a manual edit
            var i = hpos + delta;
            if(i < 0 || i >= hist.length) { paintHistory(); return; }
            hpos = i;
            box.value = hist[hpos].text;
            state.textContent = '';
            paintHistory();
          }
          undoBtn.addEventListener('click', function(){ step(-1); });
          redoBtn.addEventListener('click', function(){ step(1); });
          paintHistory();
          // The async Claude draft lands from the other script and must become a
          // version too, or the template it replaces would be unreachable.
          window.__draftVersion = function(text, label){ push(text, label); };

          /* ---- scope: whole reply, or just what you highlighted ------------
             Clicking a dropdown blurs the textarea, so the offsets are stashed
             on every selection change rather than read at click time. */
          var lastSel = null;
          function syncSel(){
            var s = box.selectionStart, e = box.selectionEnd;
            var has = e > s && box.value.slice(s, e).trim().length > 0;
            if(has) lastSel = { s: s, e: e };
            else if(document.activeElement === box) lastSel = null;
            var live = !!lastSel;
            scopeSel.disabled = !live;
            scopeSel.textContent = live
              ? 'the selection (' + (lastSel.e - lastSel.s) + ' chars)'
              : 'the selection';
            if(live && document.activeElement === box) scope.value = 'sel';
            if(!live && scope.value === 'sel') scope.value = 'all';
            selBtn.disabled = !live;
          }
          ['select','keyup','mouseup','input','focus'].forEach(function(ev){
            box.addEventListener(ev, syncSel);
          });
          syncSel();

          // One path for every tool. A selection is just an extra argument, so
          // "make it friendlier" and "make this sentence friendlier" are the
          // same request - and the result is spliced back rather than replacing
          // the draft.
          function apply(kind, option, label){
            // Reword is about a passage by definition, so it does not need the
            // scope set as well - highlighting is the whole gesture.
            var useSel = (kind === 'rephrase' || scope.value === 'sel') && lastSel;
            var sel = useSel ? box.value.slice(lastSel.s, lastSel.e) : '';
            if(kind === 'rephrase' && !sel){ state.textContent = 'Highlight some text first.'; return; }
            var at = useSel ? { s: lastSel.s, e: lastSel.e } : null;
            window.__draftEdited = true;   // a late async draft must not eat this
            busy(true, useSel ? 'rewriting the selection' : 'rewriting');
            post({ kind: kind, option: option, selection: sel, text: box.value }).then(function(d){
              busy(false);
              if(!d.ok){ state.textContent = '⚠️ ' + (d.error || 'failed'); return; }
              if(at){
                push(box.value.slice(0, at.s) + d.text + box.value.slice(at.e), label + ' (passage)');
                box.focus();
                box.setSelectionRange(at.s, at.s + d.text.length);  // left selected to compare
                syncSel();
                state.textContent = '✓ passage rewritten';
              } else {
                push(d.text, label);
                state.textContent = '✓ updated';
              }
            }).catch(function(){ busy(false); state.textContent = '⚠️ request failed'; });
          }

          document.querySelectorAll('.aitools button[data-kind]').forEach(function(b){
            b.addEventListener('click', function(){
              apply(b.dataset.kind, b.dataset.option, b.dataset.option || b.dataset.kind);
            });
          });
          if(tone) tone.addEventListener('change', function(){
            if(tone.value){ apply('tone', tone.value, tone.value); tone.value = ''; }
          });
          if(lang) lang.addEventListener('change', function(){
            if(lang.value){ apply('language', lang.value, 'in ' + lang.value); lang.value = ''; }
          });

          var go = document.getElementById('t-go');
          if(go) go.addEventListener('click', function(){
            var note = custom.value.trim();
            if(!note){ state.textContent = 'Type what to change first.'; return; }
            apply('custom', note, note.length > 24 ? note.slice(0, 24) + '…' : note);
          });

          // Translate one of their messages in place, keeping the original.
          document.querySelectorAll('button.tmsg').forEach(function(b){
            b.addEventListener('click', function(){
              var target = document.querySelector('.msgtext[data-i="' + b.dataset.i + '"]');
              if(!target) return;
              if(target.dataset.original){          // toggle back
                target.textContent = target.dataset.original;
                delete target.dataset.original;
                b.textContent = '🌐 Translate';
                return;
              }
              var original = target.textContent;
              b.disabled = true; b.textContent = '🌐 translating…';
              post({ kind: 'translate', option: 'English', text: original }).then(function(d){
                b.disabled = false;
                if(!d.ok){ b.textContent = '⚠️ ' + (d.error || 'failed'); return; }
                target.dataset.original = original;
                target.textContent = d.text;
                b.textContent = '↩ Show original';
              }).catch(function(){ b.disabled = false; b.textContent = '⚠️ failed'; });
            });
          });
        })();
        </script>` : ''}

        ${wantsAsyncAI ? `<script>
        (function(){
          var url = ${JSON.stringify('/reply/' + lead.id + '/ai?intent=' +
            encodeURIComponent(chosen) + '&instruction=' + encodeURIComponent(instruction))};
          var state = document.getElementById('aistate');
          var fallbackLine = document.getElementById('aifallbackline');
          var box = document.querySelector('textarea[name=text]');
          var subj = document.querySelector('input[name=subject]');
          var touched = false;
          // Never overwrite something the operator has already started typing.
          box.addEventListener('input', function(){ touched = true; });
          // The label and reasoning are model output, so escape them rather
          // than trusting them into innerHTML.
          function esc(s){
            return String(s == null ? '' : s)
              .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }

          fetch(url, { headers: { 'Accept': 'application/json' } })
            .then(function(r){ return r.json(); })
            .then(function(d){
              if(!d.ok){
                state.hidden = true;
                if(fallbackLine) fallbackLine.hidden = false;
                return;
              }
              if(touched || window.__draftEdited){
                state.innerHTML = '<span style="color:#b45309;font-weight:600">✨ Claude finished, ' +
                  'but you had already started editing</span> — your text was kept. ' +
                  '<a href="' + location.href + '">Reload to use Claude\\'s version</a>.';
                return;
              }
              if(d.subject) subj.value = d.subject;
              // Go through the history so "↶ Back" returns to the template draft.
              if(window.__draftVersion) window.__draftVersion(d.text, "Claude's draft");
              else box.value = d.text;
              state.innerHTML = '<span style="color:#059669;font-weight:600">✨ Claude wrote this</span> ' +
                'for their latest message. Read as: <b>' + esc(d.label) + '</b>' +
                (d.why ? ' — ' + esc(d.why) : '');
            })
            .catch(function(){
              state.hidden = true;
              if(fallbackLine) fallbackLine.hidden = false;
            });
        })();
        </script>` : ''}
      `));
    } catch (e) { return back(res, '⚠️ Could not draft a reply: ' + e.message); }
  });

  // The Claude draft, fetched by the page after it has already rendered.
  // Returns JSON; a failure here just leaves the rule-based draft in place.
  app.get('/reply/:id/ai', async (req, res) => {
    try {
      const r = await db.q('SELECT * FROM leads WHERE id = $1', [req.params.id]);
      const lead = r.rows[0];
      if (!lead) return res.status(404).json({ ok: false, error: 'lead not found' });

      let thread = [];
      if (lead.reply_thread || lead.thread_id) {
        try { thread = await email.fetchThread(lead.reply_thread || lead.thread_id); }
        catch (e) { thread = []; }
      }
      const d = await replydraft.draftSmart({
        lead, thread,
        intentOverride: String(req.query.intent || ''),
        instruction: String(req.query.instruction || ''),
        useAI: true
      });
      res.json({
        ok: d.source === 'ai',
        source: d.source,
        error: d.aiError || '',
        label: d.label || '',
        why: d.why || '',
        subject: d.subject || '',
        text: d.text || '',
        pushesForMeeting: !!d.pushesForMeeting
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Editing tools: tone, length, language, rephrase-a-selection, and translating
  // their message. All go through one endpoint and return JSON.
  app.post('/reply/:id/transform', async (req, res) => {
    try {
      const r = await db.q('SELECT * FROM leads WHERE id = $1', [req.params.id]);
      const lead = r.rows[0];
      if (!lead) return res.status(404).json({ ok: false, error: 'lead not found' });
      const out = await ai.transform({
        kind: String(req.body.kind || ''),
        option: String(req.body.option || ''),
        text: String(req.body.text || ''),
        selection: String(req.body.selection || ''),
        lead
      });
      res.json(out);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
      // Stamping this is what lets the dashboard tell "waiting on them" from
      // "waiting on you" when they write again.
      await db.updateLead(lead.id, { last_outbound_at: new Date().toISOString() });
      await db.logEvent(lead.id, 'reply_sent');
      return back(res, `✉ Replied to ${lead.name} <${lead.email}> in the same thread.`);
    } catch (e) { return back(res, '⚠️ Reply failed: ' + e.message); }
  });

  // API keys. Stored in `settings` like every other runtime value, so adding one
  // takes effect on the next request rather than needing a Railway redeploy.
  const KEY_TARGETS = {
    anthropic: { mod: ai, label: 'Anthropic API key', prefix: /^sk-ant-/ },
    apify: { mod: apify, label: 'Apify token', prefix: /^apify_api_/ }
  };

  app.post('/keys', async (req, res) => {
    const t = KEY_TARGETS[String(req.body.which || '')];
    if (!t) return back(res, '⚠️ Unknown key.');
    const key = String(req.body.key || '').trim();
    if (!key) return back(res, `⚠️ Nothing saved - the ${t.label} field was empty.`);
    // A wrong-service paste is the most likely mistake, and it would otherwise
    // only surface later as a confusing auth failure.
    if (!t.prefix.test(key)) {
      return back(res, `⚠️ That does not look like an ${t.label} - it should start with "${t.prefix.source.replace(/[\^\\]/g, '')}".`);
    }
    try {
      await t.mod.setKey(key);
      return back(res, `🔑 ${t.label} saved (…${key.slice(-4)}). It is in use from now on.`);
    } catch (e) { return back(res, `⚠️ Could not save the ${t.label}: ${e.message}`); }
  });

  app.post('/keys/clear', async (req, res) => {
    const t = KEY_TARGETS[String(req.body.which || '')];
    if (!t) return back(res, '⚠️ Unknown key.');
    try {
      await t.mod.setKey('');
      const now = await t.mod.keyStatus();
      return back(res, now.set
        ? `🔑 ${t.label} removed here - falling back to the Railway variable.`
        : `🔑 ${t.label} removed.`);
    } catch (e) { return back(res, `⚠️ Could not remove the ${t.label}: ${e.message}`); }
  });

  app.post('/keys/test', async (req, res) => {
    try {
      const r = await ai.testKey();
      return back(res, r.ok
        ? `✅ Claude is working - ${esc(r.model)} replied "${esc(r.said)}". Replies will be written by AI from now on.`
        : `❌ Claude did not answer: ${esc(r.error)}`);
    } catch (e) { return back(res, '❌ Test failed: ' + e.message); }
  });

  app.post('/criteria', async (req, res) => {
    try {
      // checkboxes: an unticked box is absent from the body entirely
      req.body.scanReviews = req.body.scanReviews ? 'true' : 'false';
      req.body.enrichFromSite = req.body.enrichFromSite ? 'true' : 'false';
      await criteria.set(req.body || {});
    } catch (e) { console.error('[criteria]', e.message); }
    // Was always '/', which silently dropped the drawer + any active filter
    // the moment you saved criteria. The form's hidden `back` field (set to
    // this same view with ?panel=settings) is what keeps both in place.
    res.redirect(backUrl(req));
  });
  app.post('/quota', async (req, res) => {
    try {
      const n = Number(req.body.value);
      await criteria.set({ dailyQuotaOverride: Number.isFinite(n) && n > 0 ? n : 0 });
      return back(res, n > 0 ? `Daily send quota set to ${n}/day.` : 'Daily send quota reset to the automatic warm-up ramp.');
    } catch (e) { return back(res, '⚠️ Could not set quota: ' + e.message); }
  });
  // Immediate "N new replies" email, separate from the daily 08:00 summary
  // (same recipient) - turning this off must not silence that digest too.
  app.post('/settings/reply-alerts', async (req, res) => {
    const on = !!req.body.enabled;
    await db.setSetting('reply_alert_enabled', on ? 'true' : 'false');
    return back(res, on
      ? '🔔 Reply-alert emails turned on.'
      : '🔔 Reply-alert emails turned off - replies still show on the dashboard, and the daily summary is unaffected.');
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
      let named = 0, linked = 0, phoned = 0;
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
          if (found.phone && !row.phone) {
            fields.phone = found.phone;
            fields.phone_source = found.phoneSource;
            phoned++;
          }
          await db.updateLead(row.id, fields);
        } catch (e) { /* one bad site must not stop the batch */ }
      }
      console.log(`[enrich] backfill done: ${rows.length} sites read, ${named} names, ${linked} LinkedIn URLs, ${phoned} phones`);
    })().catch((e) => console.error('[enrich] backfill crashed', e));

    return back(res, `🔎 Reading ${rows.length} studio website${rows.length === 1 ? '' : 's'} in the background. Refresh in a minute to see names, phones and LinkedIn links appear.`);
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
