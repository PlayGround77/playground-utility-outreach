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
  const opener = names.length > 1
    ? `I came across ${studio} and really liked what you've built — apps like ${appPhrase(names)}.`
    : names.length === 1
      ? `I came across ${studio} and really liked what you've built with ${names[0]}.`
      : `I came across ${studio} and really liked your portfolio of utility apps.`;
  const html =
    `Hi ${studio} team,<br><br>` +
    `${opener}<br><br>` +
    `I'm ${config.brand.ownerName} from ${config.brand.companyName}, where we publish mobile ` +
    `utility apps. We partner with studios building high-retention utility apps that have strong ` +
    `monetization potential, and I think ${studio} could be a great fit.<br><br>` +
    `Would you be open to a quick 15-minute call to explore working together?` +
    signature();
  return { subject: `Quick question about ${studio}`, html };
}

function fu1(lead) {
  const html =
    `Hi ${lead.name} team,<br><br>` +
    `Just floating this back to the top of your inbox. We're actively signing new utility-app ` +
    `studios this month, and I'd love to see if there's a fit with ${config.brand.companyName}.<br><br>` +
    `Any interest in a quick 15-minute call?` +
    signature();
  return { html };
}

function fu2(lead) {
  const names = appNames(lead);
  const ref = names.length > 1
    ? `I still think your apps (${appPhrase(names)}) show real promise.`
    : names.length === 1
      ? `I still think ${names[0]} shows real promise.`
      : 'I still think your apps show real promise.';
  const html =
    `Hi ${lead.name} team,<br><br>` +
    `I'll close the loop here so I'm not cluttering your inbox. ${ref}<br><br>` +
    `If publishing with ${config.brand.companyName} is ever of interest, the door stays open — ` +
    `just reply and we'll pick it up.` +
    signature();
  return { html };
}

module.exports = { initial, fu1, fu2, signature };
