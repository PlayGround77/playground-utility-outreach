'use strict';

/**
 * Reading a studio's own website to find the human behind the app.
 *
 * This is the step that upgrades a *guessed* name (derived from an email
 * local-part) into a real one, and it is the only source here that can hand us
 * an actual LinkedIn URL - because indie studios routinely link their own
 * profile in a footer or an About page. We only ever read pages the studio
 * published about itself.
 *
 * Deliberately conservative, because unlike AppStoreSpy these are arbitrary
 * third-party servers: hard timeout, capped response size, capped redirects,
 * at most a few pages per domain, robots.txt respected, and a daily call budget
 * so a bad run cannot turn into a crawl. Every failure is swallowed and
 * reported as "nothing found" - enrichment must never break a sourcing run.
 */

const people = require('./people');

const UA = 'Mozilla/5.0 (compatible; PlygrndStudioBot/1.0; +https://www.plygrndstudio.com; contact@plygrndstudio.com)';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;      // 1 MB - plenty for an About page
const MAX_REDIRECTS = 3;
const PAGES_PER_SITE = 4;           // homepage + up to 3 likely pages
const DAILY_FETCH_CAP = 1500;

const SUBPAGES = ['/about', '/about-us', '/team', '/contact', '/company'];

let fetchesToday = 0;
let fetchDay = '';

function underFetchCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== fetchDay) { fetchDay = today; fetchesToday = 0; }
  return fetchesToday < DAILY_FETCH_CAP;
}

/** GET a URL with a hard timeout, a size cap and manual redirect handling. */
async function getPage(url, depth = 0) {
  if (depth > MAX_REDIRECTS || !underFetchCap()) return '';
  fetchesToday++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return '';
      return await getPage(new URL(loc, url).toString(), depth + 1);
    }
    if (!res.ok) return '';

    const ctype = res.headers.get('content-type') || '';
    if (ctype && !/text\/html|application\/xhtml/i.test(ctype)) return '';

    // Cap the body even when the server sends no content-length.
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return '';
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch (e) {
    return ''; // timeout, DNS failure, bad TLS, connection reset - all "nothing found"
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal robots.txt check for our own User-Agent and `*`.
 * Only honours Disallow lines, which is what matters for "may we read this".
 * A missing or unreadable robots.txt means allowed, per the standard.
 */
async function allowedByRobots(origin, path) {
  let txt = '';
  try { txt = await getPage(origin + '/robots.txt'); } catch (e) { return true; }
  if (!txt) return true;

  let applies = false;
  const disallows = [];
  for (const line of txt.split('\n')) {
    const s = line.split('#')[0].trim();
    if (!s) continue;
    const m = s.match(/^(user-agent|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = m;
    if (/user-agent/i.test(key)) {
      applies = val === '*' || /plygrndstudiobot/i.test(val);
    } else if (applies && val) {
      disallows.push(val);
    }
  }
  return !disallows.some((d) => path.startsWith(d));
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[A-Za-z0-9._%-]{2,100}/gi;
// Lengths are bounded on purpose. An unbounded `+` before the literal @ is
// quadratic on a long run of matching characters with no @ in it, which is
// exactly what a minified bundle or a padded page looks like. RFC 5321 caps the
// local part at 64 characters anyway.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g;

// "Founder: Jane Doe", "Jane Doe, Co-Founder", "Made by Jane Doe"
//
// These patterns must NOT carry the /i flag. Capitalisation is the only thing
// separating a name from surrounding prose, and /i makes [A-Z] match lowercase
// too - which both swallows the next word ("Jane Doe li") and lets the nested
// quantifiers backtrack catastrophically on a large page. So the role keywords
// spell out their own case instead.
function ci(src) {
  return src.replace(/[a-z]/gi, (c) => '[' + c.toLowerCase() + c.toUpperCase() + ']');
}
const ROLE = '(?:' + ['founder', 'co-?founder', 'owner', 'ceo', 'cto', 'creator',
  'developer', 'indie developer', 'maker'].map(ci).join('|') + ')';
// One word of a name: "Jane", "O'Brien", "Anne-Marie", "d'Angelo".
const WORD = "[A-Z][a-z]{0,19}(?:['’-][A-Za-z][a-z]{0,19})?";
const NAME = `${WORD}(?:\\s+${WORD}){1,2}`;
const NAME_PATTERNS = [
  new RegExp(`${ROLE}\\s*[:\\-–—]?\\s*(${NAME})`, 'g'),
  new RegExp(`(${NAME})\\s*[,\\-–—|]\\s*(?:${ci('the')}\\s+)?${ROLE}`, 'g'),
  new RegExp(`(?:${ci('made')}|${ci('built')}|${ci('created')}|${ci('developed')})\\s+${ci('by')}\\s+(${NAME})`, 'g'),
  new RegExp(`(?:${ci("i'?m")}|${ci('i am')}|${ci('my name is')})\\s+(${NAME})`, 'g')
];

// Name-hunting runs regexes with nested quantifiers, so never point them at an
// unbounded page. An About blurb is well inside this.
const MAX_SCAN_CHARS = 200000;

/** Strip tags/scripts so regexes match visible copy, not markup. */
function toText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ');
}

/** Pull LinkedIn URLs out of raw HTML; personal profiles beat company pages. */
function findLinkedIn(html) {
  const hits = String(html || '').match(LINKEDIN_RE) || [];
  const clean = hits.map((h) => h.replace(/[).,'"]+$/, ''));
  return clean.find((h) => /\/in\//i.test(h)) || clean[0] || '';
}

/** Find a person name in page text, rejecting anything that reads as a company. */
function findPersonName(text) {
  const hay = String(text || '').slice(0, MAX_SCAN_CHARS);
  for (const re of NAME_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(hay)) !== null) {
      const cand = (m[1] || '').trim();
      if (people.looksLikePerson(cand)) return cand;
      if (re.lastIndex === m.index) re.lastIndex++; // never spin on a zero-width match
    }
  }
  return '';
}

/** Prefer a personal address over a role one (jane@x.com beats info@x.com). */
function findBetterEmail(text, domain) {
  const hits = (String(text || '').slice(0, MAX_SCAN_CHARS).match(EMAIL_RE) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(e))
    .filter((e) => !domain || e.endsWith('@' + domain));
  for (const e of hits) {
    if (people.nameFromEmail(e).confidence === 'high') return e;
  }
  return '';
}

// ---------------------------------------------------------------------------

/**
 * Fetch a studio site and extract what we can about the person behind it.
 * Always resolves - never throws - so callers can treat it as best-effort.
 *
 * Returns { contactName, linkedin, email, pagesRead, source: 'site' }.
 */
async function enrichFromSite(website) {
  const empty = { contactName: '', linkedin: '', email: '', pagesRead: 0, source: 'site' };
  let base;
  try {
    const raw = String(website || '').trim();
    if (!raw) return empty;
    base = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(base.protocol)) return empty;
  } catch (e) {
    return empty;
  }

  const origin = base.origin;
  const domain = base.hostname.replace(/^www\./i, '');
  const out = { ...empty };

  const paths = [base.pathname && base.pathname !== '/' ? base.pathname : '/', ...SUBPAGES];
  const seen = new Set();

  for (const path of paths) {
    if (out.pagesRead >= PAGES_PER_SITE) break;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!underFetchCap()) break;

    let allowed = true;
    try { allowed = await allowedByRobots(origin, path); } catch (e) { allowed = true; }
    if (!allowed) continue;

    const html = await getPage(origin + path);
    if (!html) continue;
    out.pagesRead++;

    const text = toText(html);
    if (!out.linkedin) out.linkedin = findLinkedIn(html);
    if (!out.contactName) out.contactName = findPersonName(text);
    if (!out.email) out.email = findBetterEmail(text, domain);

    if (out.linkedin && out.contactName) break; // nothing better to find
  }
  return out;
}

module.exports = {
  enrichFromSite,
  // exported for direct exercise without network I/O
  toText, findLinkedIn, findPersonName, findBetterEmail, allowedByRobots, underFetchCap
};
