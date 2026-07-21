/**
 * Code.gs — PlayGround Utility Outreach Engine.
 *
 * Runtime: Google Apps Script. Data store: Google Sheets (see Sheet.gs).
 * Requires the Gmail Advanced Service (Gmail API v1) to be enabled
 * (Services > + > Gmail API) for raw-MIME sends + reliable threading.
 *
 * Scheduled triggers (installed by SETUP):
 *   runSender        every 15 min   sending engine
 *   runReplyWatcher  every 30 min   reply / bounce detection
 *   runDailySummary  daily 08:00    report + counter reset
 * Plus runPoolRefill (daily 07:30) installed by SETUP_POOL_REFILL in PoolRefill.gs.
 */

/* =========================================================================
 * SMALL UTILITIES
 * ========================================================================= */

function log_(msg) { console.log(msg); }
function dry_() { return CONFIG.DRY_RUN === true; }

function secret_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing Script Property: ' + key);
  return v;
}
function props_() { return PropertiesService.getScriptProperties(); }

function nowTz_() { return new Date(); }
function fmt_(date, pattern) { return Utilities.formatDate(date, CONFIG.sender.timezone, pattern); }
function todayStamp_() { return fmt_(nowTz_(), 'yyyy-MM-dd'); }
function dayMonthLabel_() { return fmt_(nowTz_(), 'dd.MM'); }

function daysBetween_(fromStamp, toStamp) {
  if (!fromStamp) return Infinity;
  const a = new Date(fromStamp + 'T00:00:00');
  const b = new Date((toStamp || todayStamp_()) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/** Refuse to run live while unfilled <<PLACEHOLDERS>> remain in config. */
function validateForLive_() {
  if (dry_()) return; // dry runs are always allowed
  const blob = JSON.stringify(CONFIG);
  const holes = blob.match(/<<[^>]+>>/g);
  if (holes && holes.length) {
    throw new Error('Refusing live run — unfilled config placeholders: ' +
      Array.from(new Set(holes)).join(', '));
  }
}

/* =========================================================================
 * GMAIL
 * ========================================================================= */

function encodeHeaderWord_(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return s; // pure ASCII passes through
  return '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
}

function buildMime_(to, subject, html, extraHeaders) {
  const from = CONFIG.brand.ownerName
    ? '"' + CONFIG.brand.ownerName + '" <' + CONFIG.brand.ownerEmail + '>'
    : CONFIG.brand.ownerEmail;
  const headers = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encodeHeaderWord_(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  (extraHeaders || []).forEach(function (h) { headers.push(h); });
  const body = Utilities.base64Encode(html, Utilities.Charset.UTF_8);
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

function sendRaw_(mime, threadId) {
  const raw = Utilities.base64EncodeWebSafe(Utilities.newBlob(mime).getBytes());
  const resource = { raw: raw };
  if (threadId) resource.threadId = threadId;
  return Gmail.Users.Messages.send(resource, 'me');
}

/** First (root) Message-ID header of a thread — needed to thread follow-ups. */
function threadRootMessageId_(threadId) {
  const thread = Gmail.Users.Threads.get('me', threadId, { format: 'metadata', metadataHeaders: ['Message-ID'] });
  const first = thread.messages && thread.messages[0];
  if (!first) return '';
  const h = (first.payload.headers || []).filter(function (x) { return x.name.toLowerCase() === 'message-id'; })[0];
  return h ? h.value : '';
}

/* =========================================================================
 * GMAIL LABELS
 * ========================================================================= */

function ensureLabels_() {
  const wanted = [
    CONFIG.labels.root, CONFIG.labels.sent, CONFIG.labels.fu1, CONFIG.labels.fu2,
    CONFIG.labels.replied, CONFIG.labels.closed, CONFIG.labels.bounced
  ];
  wanted.forEach(function (name) {
    if (!GmailApp.getUserLabelByName(name)) {
      if (dry_()) { log_('[DRY] create label ' + name); }
      else { GmailApp.createLabel(name); }
    }
  });
}

function labelSearchToken_(labelName) {
  return 'label:' + labelName.replace(/\//g, '-').replace(/\s+/g, '-').toLowerCase();
}

function applyLabel_(threadId, labelName) {
  if (dry_()) { log_('[DRY] label thread ' + threadId + ' -> ' + labelName); return; }
  const label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
  const thread = GmailApp.getThreadById(threadId);
  if (thread) label.addToThread(thread);
}

/* =========================================================================
 * TEMPLATES  (PlayGround / utility-app copy — no third-party references)
 * ========================================================================= */

function latinTopApp_(topApp) {
  const t = String(topApp || '').trim();
  if (!t) return '';
  if (hasCJK_(t)) return ''; // never let a non-Latin title into a template
  return t;
}

function buildSignature_() {
  const b = CONFIG.brand;
  function real_(v) { return v && String(v).indexOf('<<') === -1 && String(v).trim() !== '' ? String(v).trim() : ''; }

  const lines = [];
  lines.push('<b>' + b.ownerName + '</b>');
  lines.push(b.ownerTitle + ', ' + b.companyName);

  const contact = [b.ownerEmail];
  if (real_(b.phone)) contact.push(b.phone);
  lines.push(contact.join(' &nbsp;|&nbsp; '));

  const links = [];
  if (real_(b.calendarUrl)) links.push('<a href="' + b.calendarUrl + '">Book a meeting</a>');
  if (real_(b.publishUrl)) links.push('<a href="' + b.publishUrl + '">Publish your app</a>');
  if (real_(b.website)) links.push('<a href="' + b.website + '">' + b.website.replace(/^https?:\/\//, '') + '</a>');
  if (links.length) lines.push(links.join(' &nbsp;&bull;&nbsp; '));

  return '<br><br>--<br>' + lines.join('<br>');
}

function tmplInitial_(item) {
  const studio = item.name;
  const app = latinTopApp_(item.topApp);
  const opener = app
    ? 'I came across ' + studio + ' and really liked what you\'ve built with ' + app + '.'
    : 'I came across ' + studio + ' and really liked your portfolio of utility apps.';
  const html =
    'Hi ' + studio + ' team,<br><br>' +
    opener + '<br><br>' +
    'I\'m ' + CONFIG.brand.ownerName + ' from ' + CONFIG.brand.companyName +
    ', where we publish mobile utility apps. We partner with studios building ' +
    'high-retention utility apps that have strong monetization potential, and I think ' +
    studio + ' could be a great fit.<br><br>' +
    'Would you be open to a quick 15-minute call to explore working together?' +
    buildSignature_();
  return { subject: 'Quick question about ' + studio, html: html };
}

function tmplFU1_(item) {
  const html =
    'Hi ' + item.name + ' team,<br><br>' +
    'Just floating this back to the top of your inbox. We\'re actively signing new ' +
    'utility-app studios this month, and I\'d love to see if there\'s a fit with ' +
    CONFIG.brand.companyName + '.<br><br>' +
    'Any interest in a quick 15-minute call?' +
    buildSignature_();
  return { html: html };
}

function tmplFU2_(item) {
  const app = latinTopApp_(item.topApp);
  const ref = app
    ? 'I still think ' + app + ' shows real promise.'
    : 'I still think your apps show real promise.';
  const html =
    'Hi ' + item.name + ' team,<br><br>' +
    'I\'ll close the loop here so I\'m not cluttering your inbox. ' + ref + '<br><br>' +
    'If publishing with ' + CONFIG.brand.companyName + ' is ever of interest, the door stays ' +
    'open — just reply and we\'ll pick it up.' +
    buildSignature_();
  return { html: html };
}

/* =========================================================================
 * DAILY COUNTERS + QUOTA
 * ========================================================================= */

function ensureDailyCounters_() {
  const p = props_();
  if (p.getProperty('counterDate') !== todayStamp_()) {
    p.setProperty('counterDate', todayStamp_());
    p.setProperty('sentToday', '0');
    p.setProperty('bouncedToday', '0');
  }
}
function getCounter_(k) { return parseInt(props_().getProperty(k) || '0', 10); }
function bumpCounter_(k, n) { props_().setProperty(k, String(getCounter_(k) + (n || 1))); }

function dailyQuota_() {
  const ramp = CONFIG.sender.ramp;
  const start = new Date(CONFIG.sender.rampStartDate + 'T00:00:00');
  const weeks = Math.floor((nowTz_() - start) / (7 * 86400000));
  const idx = Math.min(Math.max(weeks, 0), ramp.length - 1);
  return ramp[idx];
}

function withinWindow_() {
  const dow = parseInt(fmt_(nowTz_(), 'u'), 10) % 7; // 'u': 1=Mon..7=Sun -> 0=Sun..6=Sat
  if (CONFIG.sender.skipWeekdays.indexOf(dow) !== -1) return false;
  const hour = parseInt(fmt_(nowTz_(), 'H'), 10);
  return hour >= CONFIG.sender.windowStartHour && hour < CONFIG.sender.windowEndHour;
}

function remainingRunsToday_() {
  const hour = parseInt(fmt_(nowTz_(), 'H'), 10);
  const min = parseInt(fmt_(nowTz_(), 'm'), 10);
  const minsLeft = (CONFIG.sender.windowEndHour * 60) - (hour * 60 + min);
  return Math.max(1, Math.ceil(minsLeft / 15));
}

function jitterSleep_() {
  if (dry_()) return;
  const lo = CONFIG.sender.jitterMinSec, hi = CONFIG.sender.jitterMaxSec;
  const secs = lo + Math.floor(Math.random() * (hi - lo + 1));
  Utilities.sleep(secs * 1000);
}

/* =========================================================================
 * SENDING ENGINE
 * ========================================================================= */

function runSender() {
  validateForLive_();
  if (!withinWindow_()) { log_('Outside sending window — skip.'); return; }

  ensureDailyCounters_();
  const quota = dailyQuota_();
  const sentToday = getCounter_('sentToday');
  const bouncedToday = getCounter_('bouncedToday');
  const remaining = quota - sentToday;

  // Bounce brake.
  if (sentToday >= CONFIG.safety.minSendsForBrake &&
      (bouncedToday / Math.max(sentToday, 1)) > CONFIG.safety.bounceRatioMax) {
    log_('⛔ Bounce brake engaged (' + bouncedToday + '/' + sentToday + ') — pausing sends.');
    return;
  }

  const all = fetchAllItems_();

  // Status maintenance that does not consume quota.
  runCloseSweep_(all);

  if (remaining <= 0) { log_('Quota reached (' + sentToday + '/' + quota + ').'); return; }

  let budget = Math.min(remaining, Math.max(1, Math.ceil(remaining / remainingRunsToday_())));
  const seen = {}; // in-run dedup by email

  budget -= processFollowups_(all, 'fu2', budget, seen);
  if (budget > 0) budget -= processFollowups_(all, 'fu1', budget, seen);
  if (budget > 0) processNew_(all, budget, seen);
}

/** Close sequences whose FU2 aged past the close window (no email sent). */
function runCloseSweep_(all) {
  const L = CONFIG.sheet.outreachLabels, R = CONFIG.sheet.responseLabels;
  all.forEach(function (it) {
    if (it.outreach === L.fu2Sent && !it.response &&
        daysBetween_(it.fu2Date, todayStamp_()) >= CONFIG.sender.closeAfterDays) {
      setItemFields_(it, { outreach: L.sequenceClosed, response: R.noResponse });
      if (it.threadId) applyLabel_(it.threadId, CONFIG.labels.closed);
      log_('CLOSE ' + it.name);
    }
  });
}

/** Returns count actually sent. type = 'fu1' | 'fu2'. */
function processFollowups_(all, type, budget, seen) {
  if (budget <= 0) return 0;
  const L = CONFIG.sheet.outreachLabels;
  const isFU2 = type === 'fu2';

  const due = all.filter(function (it) {
    if (!it.email || !it.threadId) return false;
    if (it.response) return false; // any reply/manual value stops the sequence
    if (inBlockedGroup_(it)) return false;
    if (isFU2) {
      return it.outreach === L.fu1Sent &&
        daysBetween_(it.fu1Date, todayStamp_()) >= CONFIG.sender.fu2AfterDays;
    }
    return it.outreach === L.emailSent &&
      daysBetween_(it.initialDate, todayStamp_()) >= CONFIG.sender.fu1AfterDays;
  });

  let sent = 0;
  for (let i = 0; i < due.length && sent < budget; i++) {
    const it = due[i];
    if (seen[it.email.toLowerCase()]) continue;

    // Guards run on EVERY follow-up too.
    const reason = screenReason_({ name: it.name, email: it.email, notes: it.notes, topApp: it.topApp });
    if (reason) { log_('[SKIP-FU] ' + it.name + ' :: ' + reason); continue; }

    const tmpl = isFU2 ? tmplFU2_(it) : tmplFU1_(it);
    seen[it.email.toLowerCase()] = true;

    if (dry_()) {
      log_('[DRY] FU (' + type + ') -> ' + it.email + ' (' + it.name + ')');
    } else {
      const rootId = threadRootMessageId_(it.threadId);
      const extra = rootId ? ['In-Reply-To: ' + rootId, 'References: ' + rootId] : [];
      const subject = 'Re: Quick question about ' + it.name;
      sendRaw_(buildMime_(it.email, subject, tmpl.html, extra), it.threadId);
    }

    if (isFU2) setItemFields_(it, { outreach: L.fu2Sent, fu2Date: todayStamp_() });
    else       setItemFields_(it, { outreach: L.fu1Sent, fu1Date: todayStamp_() });
    applyLabel_(it.threadId, isFU2 ? CONFIG.labels.fu2 : CONFIG.labels.fu1);

    bumpCounter_('sentToday', 1);
    sent++;
    jitterSleep_();
  }
  if (sent) log_(type.toUpperCase() + ' sent: ' + sent);
  return sent;
}

function processNew_(all, budget, seen) {
  if (budget <= 0) return 0;
  const L = CONFIG.sheet.outreachLabels;

  const candidates = all
    .filter(function (it) { return !it.outreach && it.email && !inBlockedGroup_(it); })
    .sort(function (a, b) { return b.priority - a.priority; });

  const dateLabel = dayMonthLabel_();
  let sent = 0;

  const limit = Math.min(candidates.length, budget * CONFIG.sender.fetchMultiplier);
  for (let i = 0; i < limit && sent < budget; i++) {
    const it = candidates[i];
    const email = it.email.toLowerCase();
    if (seen[email]) continue;

    // Guard firewall.
    const reason = screenReason_({ name: it.name, email: it.email, notes: it.notes, topApp: it.topApp });
    if (reason) { log_('[SKIP] ' + it.name + ' :: ' + reason); continue; }

    // Duplicate check against Gmail history.
    if (!dry_()) {
      const already = GmailApp.search(labelSearchToken_(CONFIG.labels.sent) + ' to:' + email, 0, 1);
      if (already.length) { log_('[DUP] already emailed ' + email); seen[email] = true; continue; }
    }

    const tmpl = tmplInitial_(it);
    seen[email] = true;

    let threadId = '';
    if (dry_()) {
      log_('[DRY] NEW -> ' + it.email + ' (' + it.name + ') | subj: ' + tmpl.subject);
    } else {
      const res = sendRaw_(buildMime_(it.email, tmpl.subject, tmpl.html), null);
      threadId = res.threadId;
    }

    const newNotes = (it.notes ? it.notes + ' ' : '') + '[thread:' + (threadId || 'DRY') + ']';
    setItemFields_(it, {
      outreach: L.emailSent,
      initialDate: todayStamp_(),
      notes: newNotes,
      group: dateLabel   // "move" to today's date group
    });
    if (threadId) applyLabel_(threadId, CONFIG.labels.sent);

    bumpCounter_('sentToday', 1);
    sent++;
    jitterSleep_();
  }
  if (sent) log_('NEW sent: ' + sent);
  return sent;
}

/* =========================================================================
 * REPLY / BOUNCE WATCHER
 * ========================================================================= */

function runReplyWatcher() {
  validateForLive_();
  const L = CONFIG.sheet.outreachLabels, R = CONFIG.sheet.responseLabels;
  const me = CONFIG.brand.ownerEmail.toLowerCase();

  const active = fetchAllItems_().filter(function (it) {
    return it.threadId &&
      (it.outreach === L.emailSent || it.outreach === L.fu1Sent || it.outreach === L.fu2Sent);
  });

  active.forEach(function (it) {
    let thread;
    try { thread = GmailApp.getThreadById(it.threadId); } catch (e) { return; }
    if (!thread) return;

    let isReply = false, isBounce = false;
    thread.getMessages().forEach(function (m) {
      const from = m.getFrom().toLowerCase();
      if (from.indexOf(me) !== -1) return; // our own messages
      if (from.indexOf('mailer-daemon') !== -1 || from.indexOf('postmaster') !== -1) isBounce = true;
      else isReply = true;
    });

    if (isBounce) {
      setItemFields_(it, { response: R.notRelevant, outreach: L.sequenceClosed });
      applyLabel_(it.threadId, CONFIG.labels.bounced);
      bumpCounter_('bouncedToday', 1);
      log_('BOUNCE ' + it.name);
    } else if (isReply) {
      applyLabel_(it.threadId, CONFIG.labels.replied);
      if (!it.response) setItemFields_(it, { response: R.respond }); // never overwrite manual values
      log_('REPLY ' + it.name);
    }
  });
}

/* =========================================================================
 * DAILY SUMMARY
 * ========================================================================= */

function runDailySummary() {
  const all = fetchAllItems_();
  const L = CONFIG.sheet.outreachLabels;
  const counts = { sent: 0, fu1: 0, fu2: 0, closed: 0, replied: 0, queue: 0 };

  all.forEach(function (it) {
    if (it.outreach === L.emailSent) counts.sent++;
    else if (it.outreach === L.fu1Sent) counts.fu1++;
    else if (it.outreach === L.fu2Sent) counts.fu2++;
    else if (it.outreach === L.sequenceClosed) counts.closed++;
    if (it.response === CONFIG.sheet.responseLabels.respond) counts.replied++;
    if (!it.outreach && it.email && !inBlockedGroup_(it)) counts.queue++;
  });

  const sentToday = getCounter_('sentToday');
  const bouncedToday = getCounter_('bouncedToday');
  const quota = dailyQuota_();

  const body =
    CONFIG.brand.companyName + ' Utility Outreach — daily summary (' + todayStamp_() + ')\n\n' +
    'Sent today: ' + sentToday + ' / ' + quota + '\n' +
    'Bounced today: ' + bouncedToday + '\n' +
    'Replies awaiting you (Respond): ' + counts.replied + '\n' +
    'Queue (sendable): ' + counts.queue + '\n\n' +
    'Totals — Email Sent: ' + counts.sent + ', FU1: ' + counts.fu1 +
    ', FU2: ' + counts.fu2 + ', Closed: ' + counts.closed + '\n';

  if (dry_()) { log_('[DRY] daily summary:\n' + body); }
  else {
    GmailApp.sendEmail(CONFIG.report.summaryTo,
      '📊 ' + CONFIG.brand.companyName + ' Outreach: ' + sentToday + ' sent, ' + counts.replied + ' replies',
      body);
  }

  props_().setProperty('counterDate', todayStamp_());
  props_().setProperty('sentToday', '0');
  props_().setProperty('bouncedToday', '0');
}

/* =========================================================================
 * SETUP  (run once from the Apps Script editor)
 * ========================================================================= */

function SETUP() {
  // ⚠️ Deletes ALL triggers and recreates only the engine's three.
  // Re-run SETUP_POOL_REFILL() (in PoolRefill.gs) immediately afterward.
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('runSender').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('runReplyWatcher').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('runDailySummary').timeBased().everyDays(1)
    .atHour(CONFIG.report.dailySummaryHour).create();

  ensureLabels_();
  log_('SETUP complete. Now run SETUP_POOL_REFILL(). Triggers: runSender/15m, runReplyWatcher/30m, runDailySummary/' +
    CONFIG.report.dailySummaryHour + ':00.');
}
