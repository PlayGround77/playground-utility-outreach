'use strict';

/**
 * Finding the human behind an app.
 *
 * AppStoreSpy has no person name and no LinkedIn field at all (verified against
 * its OpenAPI schema: PlayDev exposes name/email/url/total_apps/ipd/revenue/
 * hq_country, PlayApp exposes emails/website/privacy_policy). So a contact name
 * has to be *derived*, and a LinkedIn profile can only ever be *searched for*.
 *
 * That is the design: we do not try to resolve a profile automatically. We
 * assemble the best name we can plus the context around it - their app, their
 * studio, their likely role, their country - and hand the operator a small set
 * of ready-made LinkedIn searches. A human recognises the right person in
 * seconds; a matcher would guess wrong and we would email a stranger.
 *
 * Everything here is pure (no I/O), so it is cheap to exercise directly.
 */

// Mailbox local-parts that are a role, not a person. A name derived from one of
// these would be nonsense ("Dear Info,").
const ROLE_LOCALPARTS = new Set([
  'info', 'support', 'contact', 'hello', 'hi', 'admin', 'team', 'help',
  'sales', 'office', 'mail', 'email', 'inquiries', 'enquiries', 'general',
  'service', 'services', 'feedback', 'apps', 'app', 'dev', 'devs', 'developer',
  'developers', 'studio', 'games', 'game', 'play', 'android', 'mobile',
  'business', 'biz', 'marketing', 'press', 'legal', 'privacy', 'billing',
  'noreply', 'no-reply', 'donotreply', 'abuse', 'postmaster', 'webmaster',
  'me', 'my', 'user', 'users', 'customer', 'care', 'thanks', 'ask'
]);

// Words that appear in studio names, not in people's names. Used to reject a
// "name" scraped off a site that is really just the company again.
const COMPANY_WORDS = /\b(inc|llc|ltd|limited|gmbh|corp|corporation|company|co|studios?|games?|apps?|labs?|software|tech|technologies|solutions|media|digital|interactive|mobile|entertainment|group|team|sarl|bv|ab|oy|as|sa|srl|pty|pvt|llp)\b/i;

// One word of a name: "Jane", "O'Brien", "Anne-Marie", "d'Angelo".
// Kept in step with the same shape in enrich.js, which finds these on a page
// and then hands them here to be confirmed.
const NAME_PART = "[A-Z][a-z]{0,19}(?:['’-][A-Za-z][a-z]{0,19})?";

/**
 * Split an email local-part into a person name, when it plausibly is one.
 * Returns { name, confidence } - confidence is 'high' | 'low' | null.
 *
 *   daniel.cohen@studio.io -> { name: 'Daniel Cohen', confidence: 'high' }
 *   dcohen@studio.io       -> { name: '',             confidence: null   }  (initial+surname is a coin flip)
 *   info@studio.io         -> { name: '',             confidence: null   }  (role account)
 *   daniel@studio.io       -> { name: 'Daniel',       confidence: 'low'  }  (first name only)
 */
function nameFromEmail(email) {
  const none = { name: '', confidence: null };
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0) return none;

  let local = raw.slice(0, at);
  // Strip plus-addressing and any trailing digits ("daniel.cohen+play2024").
  local = local.split('+')[0].replace(/\d+$/, '');
  if (!local) return none;

  const parts = local.split(/[._-]+/).filter(Boolean);
  if (!parts.length) return none;
  if (parts.some((p) => ROLE_LOCALPARTS.has(p))) return none;

  // Two or more real word-like parts: treat as first + last.
  const words = parts.filter((p) => /^[a-z]{2,20}$/.test(p));
  if (words.length >= 2) {
    return { name: words.slice(0, 2).map(titleCase).join(' '), confidence: 'high' };
  }
  // A single word long enough to be a given name. Useful for a search, but it is
  // only a first name, so it stays low confidence.
  if (words.length === 1 && words[0].length >= 3) {
    return { name: titleCase(words[0]), confidence: 'low' };
  }
  return none;
}

function titleCase(w) {
  return String(w || '').charAt(0).toUpperCase() + String(w || '').slice(1);
}

/** Does this look like a person's name rather than a company name? */
function looksLikePerson(name) {
  const s = String(name || '').trim();
  if (s.length < 3 || s.length > 60) return false;
  if (COMPANY_WORDS.test(s)) return false;
  if (/[0-9@/]/.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  // NAME_PART tolerates a bare initial so "O'Brien" parses, which would also let
  // "A B" through. Require enough letters overall to be a real name.
  if (s.replace(/[^A-Za-z]/g, '').length < 5) return false;
  return words.every((w) => new RegExp('^' + NAME_PART + '$').test(w));
}

// ---------------------------------------------------------------------------
// LinkedIn searches
// ---------------------------------------------------------------------------

const LI_PEOPLE = 'https://www.linkedin.com/search/results/people/?keywords=';

function liSearch(keywords) {
  return LI_PEOPLE + encodeURIComponent(keywords);
}

/**
 * Build the set of LinkedIn people-searches worth offering for one lead.
 *
 * Several angles rather than one, because any single search misses: a name
 * alone is ambiguous, but a name plus a country usually is not, and an app name
 * finds people who list their own app in their headline. The last two angles
 * need no person name at all, so every lead gets something usable.
 *
 * Returns [{ label, url, why }], best angle first, deduped.
 */
function linkedinSearches({ contactName, studio, appName, country } = {}) {
  const name = String(contactName || '').trim();
  const co = cleanStudio(studio);
  const app = String(appName || '').trim();
  const geo = String(country || '').trim();
  const out = [];

  const push = (label, keywords, why) => {
    const k = String(keywords || '').replace(/\s+/g, ' ').trim();
    if (!k) return;
    if (out.some((o) => o.keywords === k)) return;
    out.push({ label, keywords: k, url: liSearch(k), why });
  };

  if (name) {
    // Name + studio is the strongest signal: indie devs list their own studio
    // as their employer, so a hit here is usually conclusive.
    if (co) push('Name + studio', `"${name}" ${co}`, 'They list the studio as their employer');
    if (geo) push('Name + country', `"${name}" ${geo}`, 'Country narrows down a common name');
    if (!co && !geo) push('Name', `"${name}"`, 'No other signal available to narrow by');
  }
  // Works with no person name at all: developers very often name their app in
  // their headline or experience.
  if (app) push('App name', `"${app}"`, 'Devs often name their app in their profile');
  if (co) {
    push('Studio + founder', `${co} founder`, 'Finds the owner when we have no name');
    push('Studio + developer', `${co} mobile developer`, 'Finds whoever actually builds it');
  }
  return out;
}

/**
 * Strip legal/boilerplate suffixes so "Foo Apps Ltd." searches as "Foo".
 * LinkedIn matches company names loosely, and the suffix mostly adds noise.
 */
function cleanStudio(studio) {
  let s = String(studio || '').trim();
  if (!s) return '';
  // Our own placeholders are not real names - never search for them.
  if (/studio unknown|^Dev #|^Unknown studio$/i.test(s)) return '';
  s = s.replace(/[,.]?\s*\b(inc|llc|l\.l\.c|ltd|limited|gmbh|corp|corporation|co|sarl|bv|ab|oy|as|sa|srl|pty|pvt|llp)\b\.?$/i, '');
  return s.replace(/\s+/g, ' ').trim();
}

// ISO-3166 alpha-2 -> name, for the countries AppStoreSpy's hq_country actually
// returns often enough to matter. Unknown codes fall through unchanged, which is
// still fine as a search keyword.
const COUNTRIES = {
  US: 'United States', GB: 'United Kingdom', UK: 'United Kingdom', CA: 'Canada',
  AU: 'Australia', NZ: 'New Zealand', IE: 'Ireland', DE: 'Germany', FR: 'France',
  ES: 'Spain', IT: 'Italy', PT: 'Portugal', NL: 'Netherlands', BE: 'Belgium',
  CH: 'Switzerland', AT: 'Austria', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  FI: 'Finland', IS: 'Iceland', PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia',
  HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria', GR: 'Greece', HR: 'Croatia',
  RS: 'Serbia', SI: 'Slovenia', EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania',
  UA: 'Ukraine', RU: 'Russia', TR: 'Turkey', IL: 'Israel', AE: 'United Arab Emirates',
  SA: 'Saudi Arabia', EG: 'Egypt', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya',
  IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal',
  CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', JP: 'Japan', KR: 'South Korea',
  SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia', TH: 'Thailand', VN: 'Vietnam',
  PH: 'Philippines', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CL: 'Chile',
  CO: 'Colombia', PE: 'Peru', UY: 'Uruguay'
};

/** Normalise hq_country ("us", "US", "United States") to a display name. */
function countryName(code) {
  const s = String(code || '').trim();
  if (!s) return '';
  if (s.length === 2) return COUNTRIES[s.toUpperCase()] || s.toUpperCase();
  return s;
}

module.exports = {
  nameFromEmail, looksLikePerson, linkedinSearches, cleanStudio, countryName,
  ROLE_LOCALPARTS
};
