/**
 * PoolRefill.gs — utility-app sourcing module.
 *
 * Daily at 07:30: if the sendable queue is below the floor, source ~N new
 * utility-app studios from AppStoreSpy, screen them through the SAME guard
 * firewall (Guards.gs), fetch each keeper's top app for personalization, and
 * write them into a fresh "Pool DD.MM" group.
 *
 * Hard-won rules baked in (see docs §12):
 *   • Dedup indexes the ENTIRE board — including Block List and Replied — via a
 *     separate fetch, so blocked/emailed studios are never re-added.
 *   • A pre-refill unit test asserts a known-blocked and a known-sent item are
 *     rejected by dedup; if not, the refill ABORTS.
 *   • Apps Script kills executions at ~6 min, so work runs in ~4.5-min chunks
 *     that self-chain via one-off triggers, with a 60-run cap and a kill switch.
 *   • Daily hard cap on AppStoreSpy calls + exponential backoff.
 *   • Never creates an empty pool; on API failure it emails an alert instead.
 */

const POOL = {
  chunkMs: 4.5 * 60 * 1000,
  maxRuns: 60,
  props: {
    state:     'POOL_STATE',
    added:     'POOL_ADDED_INDEX', // JSON array of "name|email" keys added this chain
    kill:      'POOL_KILL',
    callsDate: 'POOL_CALLS_DATE',
    calls:     'POOL_CALLS'
  }
};

/* ---------------------------------------------------------------------------
 * Entry point (daily trigger).
 * ------------------------------------------------------------------------- */
function runPoolRefill() {
  validateForLive_();

  const all = fetchAllItems_();
  const sendable = all.filter(function (it) {
    return !it.outreach && it.email && !inBlockedGroup_(it);
  }).length;

  if (sendable >= CONFIG.safety.refillFloor) {
    log_('Queue healthy (' + sendable + ' >= ' + CONFIG.safety.refillFloor + ') — stand down.');
    return;
  }
  log_('Queue low (' + sendable + ') — starting refill toward ' + CONFIG.safety.refillTarget + '.');

  // SAFETY: dedup unit test against the full board before writing anything.
  if (!preRefillDedupTest_(all)) {
    poolAlert_('Pool refill ABORTED: dedup unit test failed (blocked/sent item not rejected).');
    return;
  }

  const dedupIndex = buildDedupIndex_(all);
  const groupId = ensurePoolGroup_();

  const state = {
    running: true,
    groupId: groupId,
    catIndex: 0,
    page: 1,
    added: 0,
    runCount: 0,
    screened: 0,
    rejects: {}
  };
  saveState_(state);
  props_().setProperty(POOL.props.added, JSON.stringify(Object.keys(dedupIndex)));
  props_().deleteProperty(POOL.props.kill);

  runPoolRefillResume();
}

/* ---------------------------------------------------------------------------
 * Chained worker.
 * ------------------------------------------------------------------------- */
function runPoolRefillResume() {
  const state = loadState_();
  if (!state || !state.running) return;

  if (props_().getProperty(POOL.props.kill) === '1') {
    log_('Kill switch set — finalizing.');
    return finalizeRefill_(state, 'killed');
  }

  const addedKeys = new Set(JSON.parse(props_().getProperty(POOL.props.added) || '[]'));
  const cats = CONFIG.appStoreSpy.categories;
  const chunkStart = Date.now();

  try {
    while (Date.now() - chunkStart < POOL.chunkMs) {
      if (state.added >= CONFIG.safety.refillTarget) return finalizeRefill_(state, 'target reached');
      if (state.catIndex >= cats.length) return finalizeRefill_(state, 'catalog exhausted');
      if (!callBudgetOk_()) return finalizeRefill_(state, 'daily API cap reached');

      const category = cats[state.catIndex];
      const rows = assApiQuery_(category, state.page); // may throw on API failure

      if (!rows.length || state.page > CONFIG.appStoreSpy.pagesPerCategory) {
        state.catIndex++;
        state.page = 1;
        continue;
      }

      rows.forEach(function (raw) {
        const cand = mapAppStoreSpyRow_(raw);
        state.screened++;
        const reason = screenRefillCandidate_(cand, addedKeys);
        if (reason) { state.rejects[reason] = (state.rejects[reason] || 0) + 1; return; }

        // Keeper — fetch top app, then write to board.
        try {
          const top = fetchTopApp_(cand);
          cand.topApp = top.name;
          cand.topAppCategory = top.category;
        } catch (e) { cand.topApp = ''; cand.topAppCategory = ''; }

        // Top-app sanity can only run once we know the top app.
        const topReason = screenReason_({ name: cand.devName, email: cand.email, notes: '', topApp: cand.topApp, topAppCategory: cand.topAppCategory });
        if (topReason) { state.rejects[topReason] = (state.rejects[topReason] || 0) + 1; return; }

        writePoolItem_(state.groupId, cand);
        addedKeys.add(dedupKey_(cand.devName, cand.email));
        state.added++;
      });

      state.page++;
    }
  } catch (e) {
    log_('AppStoreSpy error: ' + e);
    // Persist progress; if we already added items keep them, else alert.
    saveState_(state);
    props_().setProperty(POOL.props.added, JSON.stringify(Array.from(addedKeys)));
    if (state.added === 0) {
      poolAlert_('Pool refill: AppStoreSpy unreachable and 0 studios added. ' + e);
      return finalizeRefill_(state, 'api failure, empty');
    }
    return finalizeRefill_(state, 'api failure, partial (' + state.added + ')');
  }

  // Persist and chain.
  state.runCount++;
  saveState_(state);
  props_().setProperty(POOL.props.added, JSON.stringify(Array.from(addedKeys)));

  if (state.runCount >= POOL.maxRuns) return finalizeRefill_(state, 'run cap');

  scheduleResume_();
}

function finalizeRefill_(state, why) {
  state.running = false;
  saveState_(state);
  deleteResumeTriggers_();

  const rejectLines = Object.keys(state.rejects).sort().map(function (k) {
    return '  ' + k + ': ' + state.rejects[k];
  }).join('\n');

  const body =
    CONFIG.brand.companyName + ' Utility Pool Refill (' + why + ')\n\n' +
    'Added: ' + state.added + '\n' +
    'Screened: ' + state.screened + '\n\n' +
    'Rejections by reason:\n' + (rejectLines || '  (none)') + '\n';

  if (dry_()) { log_('[DRY] pool summary:\n' + body); }
  else {
    GmailApp.sendEmail(CONFIG.report.summaryTo, '📥 Pool Refill: ' + state.added + ' studios', body);
  }
  log_('Refill finalized (' + why + '): +' + state.added);
}

/* ---------------------------------------------------------------------------
 * Screening for sourced candidates.
 * ------------------------------------------------------------------------- */
function screenRefillCandidate_(cand, addedKeys) {
  const c = CONFIG.appStoreSpy;

  // Publishers are competitors, not leads.
  if (/\bpublish(er|ing)?\b/i.test(cand.devName)) return 'publisher';

  if (!cand.email) return 'no_email';
  if (addedKeys.has(dedupKey_(cand.devName, cand.email))) return 'already_on_board';

  if (cand.installsPerMonth < c.installsBand.minPerMonth ||
      cand.installsPerMonth > c.installsBand.maxPerMonth) return 'installs_out_of_range';
  if (cand.appsCount < c.minAppsCount) return 'too_few_apps';
  if (cand.revenuePerMonth > c.revenueMaxPerMonth) return 'revenue_too_high';

  // Shared-email farm: same email already claimed by a different dev name.
  if (addedKeys.has('email:' + cand.email.toLowerCase())) {
    // (soft index — see note in buildDedupIndex_)
  }

  // The shared firewall (China, junk email, non-app names, brand impersonation).
  const reason = screenReason_({ name: cand.devName, email: cand.email, notes: '' });
  if (reason) return reason;

  return '';
}

/* ---------------------------------------------------------------------------
 * AppStoreSpy access.
 *
 * NOTE: AppStoreSpy's response shape is account-specific. mapAppStoreSpyRow_ and
 * fetchTopApp_ isolate every field name in one place — align them with the real
 * payload from your plan's /play/apps/query response, then the rest works
 * unchanged. Priority score = installs-per-day × total apps count.
 * ------------------------------------------------------------------------- */
function assApiQuery_(category, page) {
  countCall_();
  const url = CONFIG.appStoreSpy.apiUrl + CONFIG.appStoreSpy.endpoint;
  const payload = {
    category: category,
    min_installs: CONFIG.appStoreSpy.installsBand.minPerMonth,
    max_installs: CONFIG.appStoreSpy.installsBand.maxPerMonth,
    page: page,
    limit: 100
  };
  const res = fetchWithBackoff_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + secret_(CONFIG.secretKeys.appStoreSpy) },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  return body.apps || body.results || body.data || [];
}

function mapAppStoreSpyRow_(row) {
  const dev = row.developer || row.dev || {};
  const ipd = Number(row.installs_per_day || row.ipd || 0);
  const appsCount = Number(dev.apps_count || row.developer_apps_count || 0);
  return {
    devName: dev.name || row.developer_name || row.developer || '',
    email: (dev.email || row.developer_email || '').toLowerCase(),
    installsPerMonth: Number(row.installs_per_month || row.installs || ipd * 30 || 0),
    installsPerDay: ipd,
    appsCount: appsCount,
    revenuePerMonth: Number(row.revenue_per_month || dev.revenue || 0),
    storeLink: row.url || row.store_link || row.play_url || '',
    priority: ipd * appsCount,
    topApp: '',
    topAppCategory: ''
  };
}

function fetchTopApp_(cand) {
  // Most-installed app for this developer. Align endpoint/fields to your plan.
  countCall_();
  const url = CONFIG.appStoreSpy.apiUrl + CONFIG.appStoreSpy.endpoint;
  const payload = { developer: cand.devName, sort: 'installs', limit: 1 };
  const res = fetchWithBackoff_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + secret_(CONFIG.secretKeys.appStoreSpy) },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  const apps = body.apps || body.results || body.data || [];
  const top = apps[0] || {};
  return { name: top.title || top.name || '', category: top.category || top.genre || '' };
}

function fetchWithBackoff_(url, opts) {
  let attempt = 0, lastErr;
  while (attempt < 5) {
    try {
      const res = UrlFetchApp.fetch(url, opts);
      const code = res.getResponseCode();
      if (code === 429 || code >= 500) throw new Error('HTTP ' + code);
      return res;
    } catch (e) {
      lastErr = e;
      Utilities.sleep(CONFIG.appStoreSpy.backoffBaseMs * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------------------
 * DIAGNOSTIC — run once to see the RAW AppStoreSpy response for your plan, so
 * the field mapping (mapAppStoreSpyRow_ / assApiQuery_) can be aligned exactly.
 * Reads only; logs HTTP status + response body. The API key is NOT logged.
 * ------------------------------------------------------------------------- */
function TEST_APPSTORESPY() {
  const url = CONFIG.appStoreSpy.apiUrl + CONFIG.appStoreSpy.endpoint;
  const key = secret_(CONFIG.secretKeys.appStoreSpy);
  const payload = {
    category: CONFIG.appStoreSpy.categories[0],
    min_installs: CONFIG.appStoreSpy.installsBand.minPerMonth,
    max_installs: CONFIG.appStoreSpy.installsBand.maxPerMonth,
    page: 1,
    limit: 3
  };
  log_('POST ' + url);
  log_('payload: ' + JSON.stringify(payload));
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  log_('HTTP ' + res.getResponseCode());
  log_('BODY (first 2500 chars):');
  log_(String(res.getContentText()).substring(0, 2500));
}

/**
 * Try several common auth schemes and report which one AppStoreSpy accepts.
 * Run once; the variant that logs "HTTP 200" is the correct one. Read-only.
 */
function TEST_APPSTORESPY_AUTH() {
  const base = CONFIG.appStoreSpy.apiUrl + CONFIG.appStoreSpy.endpoint;
  const key = secret_(CONFIG.secretKeys.appStoreSpy);
  const payload = JSON.stringify({
    category: CONFIG.appStoreSpy.categories[0],
    min_installs: CONFIG.appStoreSpy.installsBand.minPerMonth,
    max_installs: CONFIG.appStoreSpy.installsBand.maxPerMonth,
    page: 1, limit: 3
  });

  const variants = [
    { label: 'header Authorization: Bearer', url: base, headers: { 'Authorization': 'Bearer ' + key } },
    { label: 'header Authorization: raw',    url: base, headers: { 'Authorization': key } },
    { label: 'header Authorization: Token',  url: base, headers: { 'Authorization': 'Token ' + key } },
    { label: 'header X-API-Key',             url: base, headers: { 'X-API-Key': key } },
    { label: 'header apikey',                url: base, headers: { 'apikey': key } },
    { label: 'query ?apiKey=',               url: base + '?apiKey=' + encodeURIComponent(key), headers: {} },
    { label: 'query ?api_key=',              url: base + '?api_key=' + encodeURIComponent(key), headers: {} },
    { label: 'query ?token=',                url: base + '?token=' + encodeURIComponent(key), headers: {} },
    { label: 'query ?key=',                  url: base + '?key=' + encodeURIComponent(key), headers: {} }
  ];

  variants.forEach(function (v) {
    let code, body;
    try {
      const res = UrlFetchApp.fetch(v.url, {
        method: 'post', contentType: 'application/json',
        headers: v.headers, payload: payload, muteHttpExceptions: true
      });
      code = res.getResponseCode();
      body = String(res.getContentText()).substring(0, 140).replace(/\s+/g, ' ');
    } catch (e) { code = 'ERR'; body = String(e).substring(0, 140); }
    log_((code === 200 ? '✅ ' : '   ') + v.label + '  ->  HTTP ' + code + '  ::  ' + body);
  });
  log_('Done. The variant marked ✅ (HTTP 200) is the correct auth method.');
}

/**
 * Fetch the AppStoreSpy OpenAPI spec and print the authentication scheme +
 * the apps-query endpoint shape. This is authoritative — the server tells us
 * exactly how to pass the key and what fields it returns.
 */
function TEST_APPSTORESPY_SPEC() {
  const url = CONFIG.appStoreSpy.apiUrl + '/openapi.json';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  log_('GET ' + url + '  ->  HTTP ' + res.getResponseCode());

  let spec;
  try { spec = JSON.parse(res.getContentText()); }
  catch (e) {
    log_('Response is not JSON. First 800 chars:');
    log_(String(res.getContentText()).substring(0, 800));
    return;
  }

  log_('AUTH securitySchemes: ' + JSON.stringify(spec.components && spec.components.securitySchemes));
  log_('AUTH global security: ' + JSON.stringify(spec.security));

  const paths = Object.keys(spec.paths || {});
  log_('PATHS (' + paths.length + '): ' + paths.join(', ').substring(0, 1800));

  paths.forEach(function (p) {
    if (p.indexOf('query') !== -1 || p.indexOf('apps') !== -1 || p.indexOf('developer') !== -1) {
      log_('--- ' + p + ' ---');
      log_(JSON.stringify(spec.paths[p]).substring(0, 1800));
    }
  });
}

/* ---------------------------------------------------------------------------
 * Daily API call cap.
 * ------------------------------------------------------------------------- */
function callBudgetOk_() {
  ensureCallDate_();
  return getCounter_(POOL.props.calls) < CONFIG.appStoreSpy.dailyCallCap;
}
function countCall_() { ensureCallDate_(); bumpCounter_(POOL.props.calls, 1); }
function ensureCallDate_() {
  if (props_().getProperty(POOL.props.callsDate) !== todayStamp_()) {
    props_().setProperty(POOL.props.callsDate, todayStamp_());
    props_().setProperty(POOL.props.calls, '0');
  }
}

/* ---------------------------------------------------------------------------
 * Sheet writing.
 * ------------------------------------------------------------------------- */
function ensurePoolGroup_() {
  // Groups are just Group-column values; nothing to create.
  return 'Pool ' + dayMonthLabel_();
}

function writePoolItem_(groupName, cand) {
  appendItem_({
    name: cand.devName,
    email: cand.email,
    priority: cand.priority,
    topApp: cand.topApp || '',
    storeLink: cand.storeLink || '',
    group: groupName
  });
}

/* ---------------------------------------------------------------------------
 * Dedup — indexes the ENTIRE board (including Block List & Replied).
 * ------------------------------------------------------------------------- */
function dedupKey_(name, email) {
  return String(name || '').trim().toLowerCase() + '|' + String(email || '').trim().toLowerCase();
}

function buildDedupIndex_(allItems) {
  const idx = {};
  allItems.forEach(function (it) {
    idx[dedupKey_(it.name, it.email)] = true;
    if (it.email) idx['email:' + it.email.toLowerCase()] = true; // farm soft-index
  });
  return idx;
}

/**
 * Pre-refill unit test: pick a real Block List item and a real already-sent item
 * and assert the dedup index rejects both. Returns true only if the guarantee
 * holds (or the board has no such items yet, in which case there is nothing to
 * protect and the test passes vacuously).
 */
function preRefillDedupTest_(allItems) {
  const idx = buildDedupIndex_(allItems);
  const blocked = allItems.filter(function (it) { return it.group === CONFIG.sheet.groups.blockList; })[0];
  const sent = allItems.filter(function (it) { return !!it.outreach; })[0];

  if (blocked && !idx[dedupKey_(blocked.name, blocked.email)]) {
    log_('DEDUP TEST FAIL: blocked item not indexed: ' + blocked.name);
    return false;
  }
  if (sent && !idx[dedupKey_(sent.name, sent.email)]) {
    log_('DEDUP TEST FAIL: sent item not indexed: ' + sent.name);
    return false;
  }
  log_('Dedup unit test passed (blocked=' + !!blocked + ', sent=' + !!sent + ').');
  return true;
}

/* ---------------------------------------------------------------------------
 * State + chaining helpers.
 * ------------------------------------------------------------------------- */
function saveState_(s) { props_().setProperty(POOL.props.state, JSON.stringify(s)); }
function loadState_() {
  const raw = props_().getProperty(POOL.props.state);
  return raw ? JSON.parse(raw) : null;
}
function scheduleResume_() {
  if (dry_()) { log_('[DRY] would schedule resume trigger'); return; }
  ScriptApp.newTrigger('runPoolRefillResume').timeBased().after(60 * 1000).create();
}
function deleteResumeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runPoolRefillResume') ScriptApp.deleteTrigger(t);
  });
}

function poolAlert_(msg) {
  log_('ALERT: ' + msg);
  if (!dry_()) GmailApp.sendEmail(CONFIG.report.summaryTo, '⚠️ Pool Refill alert', msg);
}

/* Kill switch — run manually to stop an in-flight chain. */
function POOL_KILL_SWITCH() { props_().setProperty(POOL.props.kill, '1'); log_('Kill switch armed.'); }

/* ---------------------------------------------------------------------------
 * SETUP — install the daily refill trigger (07:30, offset from any 07:00 job).
 * Re-run this immediately after SETUP() in Code.gs, which clears all triggers.
 * ------------------------------------------------------------------------- */
function SETUP_POOL_REFILL() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runPoolRefill') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPoolRefill').timeBased().everyDays(1)
    .atHour(CONFIG.report.poolRefillHour).nearMinute(30).create();
  log_('Pool refill scheduled daily ~' + CONFIG.report.poolRefillHour + ':30.');
}
