/**
 * Sheet.gs — Google Sheets data layer (replaces the Monday.com board).
 *
 * The sheet is the single source of truth. One tab ("Leads") with a header row;
 * each studio is a row. "Groups" (date groups, Block List, Replied, Pool DD.MM)
 * are just values in the Group column — "moving" an item to a group means
 * setting that cell.
 *
 * Item identity within a run is the 1-based sheet row number. We only ever
 * update existing rows or append new ones (never delete/reorder mid-run), so
 * row numbers captured at fetch time stay valid for that run.
 */

function ss_() {
  const id = CONFIG.sheet.spreadsheetId;
  if (id && id.indexOf('<<') === -1 && id !== '') return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActive();
  if (!active) {
    throw new Error('No active spreadsheet. Set CONFIG.sheet.spreadsheetId, or ' +
      'create the script from inside the Sheet (Extensions > Apps Script).');
  }
  return active;
}

function sheetTab_() {
  const sh = ss_().getSheetByName(CONFIG.sheet.tabName);
  if (!sh) throw new Error('Sheet tab not found: "' + CONFIG.sheet.tabName + '". Run SETUP_SHEET() first.');
  return sh;
}

/** header name -> 0-based column index, read from row 1. */
function headerIndex_(sh) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = {};
  headers.forEach(function (h, i) { if (h !== '' && h !== null) idx[String(h).trim()] = i; });
  return idx;
}

function normalizeDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, CONFIG.sender.timezone, 'yyyy-MM-dd');
  }
  return String(v).trim();
}

/** Read every studio row into normalized objects (same shape used everywhere). */
function fetchAllItems_() {
  const sh = sheetTab_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const lastCol = sh.getLastColumn();
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const idx = {};
  values[0].forEach(function (h, i) { if (h !== '' && h !== null) idx[String(h).trim()] = i; });
  const H = CONFIG.sheet.headers;

  function col(row, key) {
    const i = idx[H[key]];
    return i === undefined ? '' : row[i];
  }

  const items = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const name = String(col(row, 'name') || '').trim();
    const email = String(col(row, 'email') || '').trim();
    if (!name && !email) continue; // skip blank rows

    const notes = String(col(row, 'notes') || '');
    const tm = notes.match(/\[thread:([^\]]+)\]/);

    items.push({
      row: r + 1, // 1-based sheet row
      name: name,
      email: email,
      outreach: String(col(row, 'outreach') || '').trim(),
      response: String(col(row, 'response') || '').trim(),
      initialDate: normalizeDate_(col(row, 'initialDate')),
      fu1Date: normalizeDate_(col(row, 'fu1Date')),
      fu2Date: normalizeDate_(col(row, 'fu2Date')),
      priority: Number(col(row, 'priority')) || 0,
      notes: notes,
      storeLink: String(col(row, 'storeLink') || ''),
      topApp: String(col(row, 'topApp') || ''),
      group: String(col(row, 'group') || '').trim(),
      threadId: tm ? tm[1] : ''
    });
  }
  return items;
}

/**
 * Update fields on an item's row. `patch` is keyed by header-KEY
 * (name/email/outreach/response/initialDate/fu1Date/fu2Date/priority/notes/
 * storeLink/topApp/group).
 */
function setItemFields_(item, patch) {
  if (dry_()) { log_('[DRY] Sheet set row ' + item.row + ' -> ' + JSON.stringify(patch)); return; }
  const sh = sheetTab_();
  const idx = headerIndex_(sh);
  const H = CONFIG.sheet.headers;
  Object.keys(patch).forEach(function (key) {
    const c = idx[H[key]];
    if (c === undefined) throw new Error('Missing column header: ' + H[key]);
    sh.getRange(item.row, c + 1).setValue(patch[key]);
  });
}

/** Append a new studio row. `fields` keyed by header-KEY (same keys as above). */
function appendItem_(fields) {
  if (dry_()) { log_('[DRY] Sheet append -> ' + JSON.stringify(fields)); return; }
  const sh = sheetTab_();
  const idx = headerIndex_(sh);
  const H = CONFIG.sheet.headers;
  const width = sh.getLastColumn();
  const rowArr = new Array(width).fill('');
  Object.keys(fields).forEach(function (key) {
    const c = idx[H[key]];
    if (c !== undefined) rowArr[c] = fields[key];
  });
  sh.appendRow(rowArr);
}

function inBlockedGroup_(it) {
  return it.group === CONFIG.sheet.groups.blockList ||
         it.group === CONFIG.sheet.groups.replied;
}

/* ---------------------------------------------------------------------------
 * SETUP_SHEET — create the tab + header row (run once from the editor).
 * ------------------------------------------------------------------------- */
function SETUP_SHEET() {
  const cfg = CONFIG.sheet;
  const ss = ss_();
  let sh = ss.getSheetByName(cfg.tabName);
  if (!sh) sh = ss.insertSheet(cfg.tabName);

  const order = ['name', 'email', 'outreach', 'response', 'initialDate',
    'fu1Date', 'fu2Date', 'priority', 'notes', 'storeLink', 'topApp', 'group'];
  const headerRow = order.map(function (k) { return cfg.headers[k]; });

  sh.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
  log_('Sheet "' + cfg.tabName + '" ready. Headers: ' + headerRow.join(' | '));
}
