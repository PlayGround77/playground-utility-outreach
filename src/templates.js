'use strict';

const config = require('./config');
const { hasCJK } = require('./guards');

function latinTopApp(topApp) {
  const t = String(topApp || '').trim();
  if (!t || hasCJK(t)) return '';
  return t;
}

// The studio's app names (from the merged apps_json list; falls back to top_app).
function appNames(lead) {
  let list = [];
  try { list = JSON.parse(lead.apps_json || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.map((a) => latinTopApp(a)).filter(Boolean);
  if (!list.length) { const t = latinTopApp(lead.top_app); if (t) list = [t]; }
  return list;
}
function appPhrase(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

function real(v) {
  return v && String(v).indexOf('<<') === -1 && String(v).trim() !== '' ? String(v).trim() : '';
}

function signature() {
  const b = config.brand;
  const lines = [`<b>${b.ownerName}</b>`, `${b.ownerTitle}, ${b.companyName}`];
  const contact = [b.ownerEmail];
  if (real(b.phone)) contact.push(b.phone);
  lines.push(contact.join(' &nbsp;|&nbsp; '));
  const links = [];
  if (real(b.calendarUrl)) links.push(`<a href="${b.calendarUrl}">Book a meeting</a>`);
  if (real(b.publishUrl)) links.push(`<a href="${b.publishUrl}">Publish your app</a>`);
  if (real(b.website)) links.push(`<a href="${b.website}">${b.website.replace(/^https?:\/\//, '')}</a>`);
  if (links.length) lines.push(links.join(' &nbsp;&bull;&nbsp; '));
  return '<br><br>--<br>' + lines.join('<br>');
}

function initial(lead) {
  const studio = lead.name;
  const names = appNames(lead);
  const lead_app = names.length ? names[0] : 'your app';
  const appRef = names.length > 1 ? `your apps (${appPhrase(names)})` : lead_app;
  const html =
    `Hi ${studio} team,<br><br>` +
    `I came across ${lead_app} and was genuinely impressed with what you've built.<br><br>` +
    `I'm ${config.brand.ownerName} from ${config.brand.companyName}, and we acquire and grow mobile ` +
    `apps. I think ${appRef} has real potential, and I'd love to explore a possible acquisition.<br><br>` +
    `Would you be open to a quick 15-minute chat to see if there's a fit?` +
    signature();
  return { subject: `Interested in ${names.length ? lead_app : studio}`, html };
}

function fu1(lead) {
  const names = appNames(lead);
  const lead_app = names.length ? names[0] : 'your app';
  const html =
    `Hi ${lead.name} team,<br><br>` +
    `Just following up, I'm still very interested in exploring an acquisition of ${lead_app}. ` +
    `We move quickly and make the process simple for founders.<br><br>` +
    `Would a quick 15-minute call this week work?` +
    signature();
  return { html };
}

function fu2(lead) {
  const names = appNames(lead);
  const ref = names.length > 1
    ? `your apps (${appPhrase(names)})`
    : names.length === 1 ? names[0] : 'your app';
  const html =
    `Hi ${lead.name} team,<br><br>` +
    `I'll close the loop here so I'm not cluttering your inbox. If you'd ever consider selling ` +
    `${ref}, now or down the road, I'd genuinely love to talk.<br><br>` +
    `Just reply and we'll pick it up whenever the timing is right.` +
    signature();
  return { html };
}

module.exports = { initial, fu1, fu2, signature };
