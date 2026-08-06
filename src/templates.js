'use strict';

const config = require('./config');
const { hasCJK } = require('./guards');

function latinTopApp(topApp) {
  const t = String(topApp || '').trim();
  if (!t || hasCJK(t)) return '';
  return t;
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
  const app = latinTopApp(lead.top_app);
  const opener = app
    ? `I came across ${studio} and really liked what you've built with ${app}.`
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
  const app = latinTopApp(lead.top_app);
  const ref = app ? `I still think ${app} shows real promise.` : 'I still think your apps show real promise.';
  const html =
    `Hi ${lead.name} team,<br><br>` +
    `I'll close the loop here so I'm not cluttering your inbox. ${ref}<br><br>` +
    `If publishing with ${config.brand.companyName} is ever of interest, the door stays open — ` +
    `just reply and we'll pick it up.` +
    signature();
  return { html };
}

module.exports = { initial, fu1, fu2, signature };
