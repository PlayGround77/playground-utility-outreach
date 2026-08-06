'use strict';

const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const config = require('./config');

let transporter;
function tx() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.gmail.smtpHost,
      port: config.gmail.smtpPort,
      secure: true,
      auth: { user: config.gmail.user, pass: config.gmail.pass }
    });
  }
  return transporter;
}

function fromHeader() {
  return config.brand.ownerName
    ? `"${config.brand.ownerName}" <${config.gmail.user}>`
    : config.gmail.user;
}

/**
 * Send an email. For follow-ups pass inReplyTo (the initial Message-ID) to keep
 * one Gmail thread. Returns the sent Message-ID (store it for threading + reply
 * matching).
 */
async function send({ to, subject, html, inReplyTo }) {
  const opts = { from: fromHeader(), to, subject, html };
  if (inReplyTo) {
    opts.inReplyTo = inReplyTo;
    opts.references = inReplyTo;
    if (!/^re:/i.test(subject)) opts.subject = 'Re: ' + subject;
  }
  const info = await tx().sendMail(opts);
  return info.messageId;
}

/** Plain notification email (daily summary / alerts). */
async function notify(to, subject, text) {
  await tx().sendMail({ from: fromHeader(), to, subject, text });
}

/**
 * Scan the INBOX over the last `sinceDays` days and return sets of:
 *   replyEmails  — sender addresses that wrote to us (i.e. replies)
 *   bounceEmails — recipient addresses found inside mailer-daemon/postmaster bounces
 */
async function scanInbox(sinceDays) {
  const days = sinceDays || 30;
  const client = new ImapFlow({
    host: config.gmail.imapHost, port: config.gmail.imapPort, secure: true,
    auth: { user: config.gmail.user, pass: config.gmail.pass }, logger: false
  });
  const replyEmails = new Set();
  const bounceEmails = new Set();
  const me = config.gmail.user.toLowerCase();

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - days * 86400000);
    const daemonUids = [];

    for await (const msg of client.fetch({ since }, { uid: true, envelope: true })) {
      const from = (msg.envelope && msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address || '').toLowerCase();
      if (!from || from === me) continue;
      if (from.includes('mailer-daemon') || from.includes('postmaster')) {
        daemonUids.push(msg.uid);
      } else {
        replyEmails.add(from);
      }
    }

    // For bounces, download the source and extract every address mentioned.
    for (const uid of daemonUids) {
      try {
        const dl = await client.download(uid, undefined, { uid: true });
        const chunks = [];
        for await (const c of dl.content) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
        for (const addr of found) {
          const a = addr.toLowerCase();
          if (a !== me && !a.includes('mailer-daemon') && !a.includes('postmaster') && !a.includes('googlemail')) {
            bounceEmails.add(a);
          }
        }
      } catch (e) { /* skip unreadable bounce */ }
    }
  } finally {
    lock.release();
  }
  await client.logout();
  return { replyEmails, bounceEmails };
}

module.exports = { send, notify, scanInbox };
