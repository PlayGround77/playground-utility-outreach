'use strict';

const { google } = require('googleapis');
const config = require('./config');
const db = require('./db');

const TOKEN_KEY = 'google_refresh_token';

function oauthClient(redirectUri) {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, redirectUri);
}

async function isConnected() {
  return !!(await db.getSetting(TOKEN_KEY, null));
}

async function gmail() {
  const refresh = await db.getSetting(TOKEN_KEY, null);
  if (!refresh) throw new Error('Gmail not connected — click “Connect Gmail” on the dashboard.');
  const o = oauthClient();
  o.setCredentials({ refresh_token: refresh });
  return google.gmail({ version: 'v1', auth: o });
}

function fromHeader() {
  return config.gmail.user
    ? (config.brand.ownerName ? `"${config.brand.ownerName}" <${config.gmail.user}>` : config.gmail.user)
    : 'me';
}

function encodeHeader(s) {
  return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function newMessageId() {
  const dom = (config.gmail.user.split('@')[1]) || 'mail.local';
  return `<${Date.now()}.${Math.random().toString(36).slice(2)}@${dom}>`;
}

function buildMime(to, subject, html, messageId, inReplyTo) {
  const headers = [
    'From: ' + fromHeader(),
    'To: ' + to,
    'Subject: ' + encodeHeader(subject),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  if (inReplyTo) { headers.push('In-Reply-To: ' + inReplyTo); headers.push('References: ' + inReplyTo); }
  const body = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/**
 * Send an email via the Gmail API. For follow-ups pass inReplyTo (the initial
 * Message-ID) and threadId to keep one Gmail thread. Returns { messageId, threadId }.
 */
async function send({ to, subject, html, inReplyTo, threadId }) {
  const g = await gmail();
  const messageId = newMessageId();
  const subj = inReplyTo && !/^re:/i.test(subject) ? 'Re: ' + subject : subject;
  const raw = b64url(buildMime(to, subj, html, messageId, inReplyTo));
  const requestBody = { raw };
  if (threadId) requestBody.threadId = threadId;
  const res = await g.users.messages.send({ userId: 'me', requestBody });
  return { messageId, threadId: res.data.threadId || '' };
}

/** Plain notification email (daily summary / alerts / self-test). */
async function notify(to, subject, text) {
  const g = await gmail();
  const messageId = newMessageId();
  const headers = [
    'From: ' + fromHeader(), 'To: ' + to, 'Subject: ' + encodeHeader(subject),
    'Message-ID: ' + messageId, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8'
  ];
  const mime = headers.join('\r\n') + '\r\n\r\n' + text;
  await g.users.messages.send({ userId: 'me', requestBody: { raw: b64url(mime) } });
}

function headerVal(payload, name) {
  const h = (payload && payload.headers || []).filter((x) => x.name.toLowerCase() === name.toLowerCase())[0];
  return h ? h.value : '';
}

/**
 * Scan the inbox (last `days` days) via the Gmail API and return:
 *   replyEmails  — Set of sender addresses who wrote to us (replies)
 *   replyInfo    — Map addr -> { snippet, subject, date, threadId } for the
 *                  most recent reply from that address (so the dashboard can
 *                  show what they actually said, not just that they replied)
 *   bounceEmails — recipient addresses found in mailer-daemon/postmaster bounces
 */
async function scanInbox(days) {
  const g = await gmail();
  const me = config.gmail.user.toLowerCase();
  const replyEmails = new Set();
  const replyInfo = new Map();
  const bounceEmails = new Set();

  const list = await g.users.messages.list({ userId: 'me', q: `in:inbox newer_than:${days || 30}d`, maxResults: 200 });
  const ids = (list.data.messages || []).map((m) => m.id);

  for (const id of ids) {
    const msg = await g.users.messages.get({
      userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date']
    });
    const from = (headerVal(msg.data.payload, 'From') || '').toLowerCase();
    const addr = (from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [''])[0];
    if (!addr || addr === me) continue;

    if (from.includes('mailer-daemon') || from.includes('postmaster')) {
      const found = String(msg.data.snippet || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
      found.forEach((a) => {
        const l = a.toLowerCase();
        if (l !== me && !l.includes('mailer-daemon') && !l.includes('postmaster') && !l.includes('google')) bounceEmails.add(l);
      });
    } else {
      replyEmails.add(addr);
      // messages.list returns newest first, so only keep the first one seen.
      if (!replyInfo.has(addr)) {
        replyInfo.set(addr, {
          snippet: String(msg.data.snippet || '').slice(0, 500),
          subject: headerVal(msg.data.payload, 'Subject') || '',
          date: headerVal(msg.data.payload, 'Date') || '',
          threadId: msg.data.threadId || ''
        });
      }
    }
  }
  return { replyEmails, replyInfo, bounceEmails };
}

/** Walk a Gmail MIME tree and pull out the text. Prefers text/plain over HTML. */
function extractBody(payload) {
  if (!payload) return '';
  const decode = (d) => {
    try { return Buffer.from(String(d || ''), 'base64').toString('utf8'); }
    catch (e) { return ''; }
  };
  const plain = [];
  const html = [];
  (function walk(p) {
    if (!p) return;
    const type = String(p.mimeType || '');
    if (p.body && p.body.data) {
      if (type === 'text/plain') plain.push(decode(p.body.data));
      else if (type === 'text/html') html.push(decode(p.body.data));
    }
    (p.parts || []).forEach(walk);
  })(payload);

  let text = plain.join('\n').trim();
  if (!text && html.length) {
    text = html.join('\n')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  }
  return text
    .replace(/[ \t]+/g, ' ')      // collapse runs left behind by stripped tags
    .replace(/ *\n */g, '\n')     // ...including at line edges
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip the quoted history a mail client appends when replying, so we read what
 * this person actually wrote rather than our own email quoted back at us.
 */
function stripQuoted(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*On .{0,80}wrote:\s*$/i.test(line)) break;      // Gmail
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+@/i.test(line) && out.length) break;  // Outlook
    if (/^\s*_{5,}\s*$/.test(line) && out.length) break;
    out.push(line);
  }
  // Drop a trailing run of quoted lines even without a recognised header.
  while (out.length && /^\s*>/.test(out[out.length - 1])) out.pop();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Full text of a Gmail thread, newest message last.
 * The reply watcher only stores Gmail's 500-char snippet; drafting a real answer
 * needs the whole message, and the earlier turns for context.
 * Returns [{ from, date, text, fromUs }] — never throws.
 */
async function fetchThread(threadId, maxChars) {
  if (!threadId) return [];
  const cap = maxChars || 20000;
  try {
    const g = await gmail();
    const me = String(config.gmail.user || '').toLowerCase();
    const res = await g.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    return (res.data.messages || []).map((m) => {
      const from = headerVal(m.payload, 'From') || '';
      const addr = (from.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/) || [''])[0];
      return {
        from,
        date: headerVal(m.payload, 'Date') || '',
        fromUs: !!me && addr === me,
        text: stripQuoted(extractBody(m.payload)).slice(0, cap)
      };
    }).filter((m) => m.text);
  } catch (e) {
    console.log('[email] could not fetch thread ' + threadId + ': ' + e.message);
    return [];
  }
}

module.exports = { send, notify, scanInbox, isConnected, oauthClient, TOKEN_KEY, fetchThread, extractBody, stripQuoted };
