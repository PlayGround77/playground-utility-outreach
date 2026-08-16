'use strict';

/**
 * Drafting the answer to a reply.
 *
 * When someone answers the cold email, the right response depends entirely on
 * what they actually said: "how much are you offering" and "I'm not the owner"
 * need opposite emails. So this module reads the reply, classifies the intent,
 * and drafts a matching answer.
 *
 * Every draft aims at the same two outcomes, in order:
 *   1. get a call with the seller - that is where a deal actually happens
 *   2. failing that, get the app's numbers, so we can make an indicative offer
 *      without a call and keep the conversation alive
 *
 * Two intents deliberately break that pattern: a clear "not selling" gets a
 * gracious close rather than another push, and "I'm not the owner" asks for an
 * introduction instead, because pitching the wrong person harder is pointless.
 *
 * Classification is rule-based and ordered - first match wins, same convention
 * as guards.js - because there is no model available at run time and the input
 * is short. It is a *draft*: the dashboard shows the detected intent and lets
 * the operator edit every word before anything is sent.
 *
 * NOTE ON INPUT: what we classify is Gmail's snippet (capped at 500 chars in
 * email.js), not the full message body. It is the opening of the reply, which
 * is usually where the intent is, but a decisive sentence buried at the bottom
 * of a long email will be missed. The operator sees the reply text next to the
 * draft for exactly this reason.
 */

const config = require('./config');

/* ------------------------------------------------------------------ asking */

/**
 * The diligence request.
 *
 * The important move here is that we ask for *view-only access* rather than
 * asking the seller to assemble a data pack. It removes almost all the work
 * from their side ("nothing for you to prepare"), it gets us the real numbers
 * instead of their summary of the numbers, and it is what an acquirer that has
 * done this before sounds like. A homework assignment gets postponed; four
 * console invites get done the same evening.
 */
const ACCESS = [
  'App Store Connect - "Sales" role',
  'Google Play Console - this app only, with view app info / financial data / app quality',
  'RevenueCat or Adapty, or whatever you use for subscriptions - read only',
  'Your ad accounts, if you\'re running any'
];

// Only the things access cannot show us. Everything answerable from a console
// is deliberately absent, which is what keeps this to four questions.
const QUESTIONS = [
  'What are your monthly costs - API, hosting, anything recurring?',
  'Is any of the growth paid? If so, what\'s the monthly spend?',
  'Who legally owns the code and the assets?',
  'What\'s the reason for selling?'
];

function bullets(items) {
  return '<ul style="margin:.4rem 0 .6rem 1.1rem;padding:0">' +
    items.map((i) => `<li style="margin:.25rem 0">${i}</li>`).join('') + '</ul>';
}
function numbered(items) {
  return '<ol style="margin:.4rem 0 .6rem 1.1rem;padding:0">' +
    items.map((i) => `<li style="margin:.25rem 0">${i}</li>`).join('') + '</ol>';
}

/** The full "let us take a proper look" block. */
function diligenceRequest(opts) {
  const o = opts || {};
  const invite = config.brand.ownerEmail || 'us';
  const opener = o.opener ||
    'We\'d like to move forward and take a proper look at the app.';
  return (
    `${opener}<br><br>` +
    `Our review is quick - we usually come back with a number within a week. ` +
    `The easiest way to do it is view-only access, so there's nothing for you to prepare. ` +
    `We pull the numbers ourselves.<br><br>` +
    `If you can invite ${invite} to these, that covers most of it:` +
    bullets(ACCESS) +
    `Nothing sensitive at this stage - no keys, no passwords, no ownership changes. ` +
    `That all comes later, and only if we sign.<br><br>` +
    `Then just four quick questions:` +
    numbered(QUESTIONS) +
    `Happy to sign an NDA before any of this - say the word and we'll send one over today.`
  );
}

/** A one-line version for leads who are not ready for the full ask yet. */
function reviewIsEasy() {
  return `For what it's worth, our review is view-only and takes about a week - ` +
    `we get read access to the consoles and pull the numbers ourselves, so there's ` +
    `nothing for you to prepare.`;
}

/* ------------------------------------------------------------ classification */

// Ordered most-specific first: whoever matches first wins. "I'm not the owner
// but happy to chat" must land on wrong_person, not on interested.
const RULES = [
  {
    intent: 'wrong_person',
    label: 'Not the right person',
    why: 'They say they are not the owner or decision maker',
    test: /\b(not|no longer)\s+(the\s+)?(owner|developer|dev|right person|person)\b|\bwrong (person|contact|address|email)\b|\bi (just|only) work|\bi'?m not (the|involved)|\bno longer (with|at|work)|\b(left|sold) (the )?(company|studio)\b|\bforward(ed|ing)? (this|it|you) to\b/i
  },
  {
    intent: 'already_sold',
    label: 'Already sold or under contract',
    why: 'The app appears to be sold or in an exclusive process already',
    test: /\balready (sold|been sold)\b|\bwe sold\b|\bhas been (sold|acquired)\b|\bunder (contract|loi|exclusivity)\b|\bsigned (an )?loi\b/i
  },
  {
    intent: 'not_selling',
    label: 'Not selling',
    why: 'A clear no - they are not looking to sell',
    test: /\bnot (interested|for sale|looking to sell|selling|planning to sell)\b|\bno,? thank|\bnot at (this|the) (time|moment)\b(?!.*\b(later|next|future)\b)|\bwe are keeping\b|\bwon'?t be selling\b|\bplease (remove|unsubscribe|stop)\b|\bdo not (contact|email)\b/i
  },
  {
    intent: 'already_in_talks',
    label: 'Talking to other buyers',
    why: 'They mention other offers or an ongoing process',
    test: /\b(other|another|competing|multiple) (offer|offers|buyer|buyers|part(y|ies))\b|\bin (talks|discussions?|negotiations?)\b|\balready (have|had|received|got) (an? )?(offer|approach|interest)\b|\bentertaining offers\b/i
  },
  {
    intent: 'price_first',
    label: 'Wants a number first',
    why: 'They are asking what we would pay before anything else',
    test: /\bhow much\b|\bwhat (are you|would you|will you|do you) (offer|offering|pay|paying)\b|\byour (offer|budget|price|valuation)\b|\bmake (me|us) an offer\b|\bwhat'?s your (budget|offer|range)\b|\bprice range\b|\bballpark\b|\bwhat number\b/i
  },
  {
    intent: 'send_info',
    label: 'Asking what we need',
    why: 'They want to know what information to send',
    test: /\bwhat (info|information|details|data|numbers|metrics) (do you|would you|are you)\b|\bwhat do you need\b|\bwhat would you like to know\b|\bwhich (numbers|metrics|data)\b|\bhappy to share\b|\bcan send (you )?(the )?(numbers|stats|data|details)\b|\bwhat should i (send|share|provide)\b/i
  },
  {
    intent: 'who_are_you',
    label: 'Wants to know who we are',
    why: 'They are checking we are real before engaging',
    test: /\bwho are you\b|\bwhat (company|is your company)\b|\bnever heard of\b|\btell me (more )?about (you|your)\b|\byour (background|track record|portfolio|website)\b|\bwhat (apps|companies) have you (bought|acquired)\b|\bis this (a scam|legit|real)\b|\bhow many apps have you\b/i
  },
  {
    intent: 'later',
    label: 'Interested, but not now',
    why: 'Open in principle, wrong timing',
    test: /\b(not|maybe) (right )?now\b|\blater (this|next) (year|quarter|month)\b|\bcheck back\b|\bcircle back\b|\breach out (again )?(in|next|later)\b|\bin a (few|couple)( of)? (months|weeks)\b|\bnext year\b|\btoo (early|soon)\b|\bafter (the )?(launch|summer|holidays)\b|\bnot ready\b/i
  },
  {
    intent: 'interested',
    label: 'Open to talking',
    why: 'A positive signal - they are willing to engage',
    test: /\b(sounds|that sounds) (good|great|interesting)\b|\b(happy|glad|open|keen|willing) to (chat|talk|discuss|hear|explore|connect)\b|\blet'?s (talk|chat|discuss|set|schedule)\b|\b(i'?m|we'?re|am|are) interested\b|\bcall me\b|\bset up a (call|meeting|time)\b|\bwhen (are|would) you (free|available)\b|\bsure[,.!]?\b|\byes[,.!]/i
  }
];

/**
 * Work out what the reply is asking for.
 * Returns { intent, label, why } - 'unclear' when nothing matches.
 */
function classify(replyText) {
  const text = String(replyText || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return { intent: 'unclear', label: 'No reply text', why: 'Nothing was captured from the reply' };
  }
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { intent: rule.intent, label: rule.label, why: rule.why };
    }
  }
  return { intent: 'unclear', label: 'Unclear', why: 'No pattern matched - read it and pick the angle yourself' };
}

/* ----------------------------------------------------------------- drafting */

function firstName(lead) {
  // Only a name we actually verified is safe to greet by. A name guessed from
  // an email address is not - "Hi Info," or the wrong first name reads worse
  // than a neutral greeting, and this reply is a real conversation now.
  if (lead && lead.contact_name && lead.contact_name_source === 'site') {
    return String(lead.contact_name).split(/\s+/)[0];
  }
  return '';
}

function greeting(lead) {
  const fn = firstName(lead);
  if (fn) return `Hi ${fn},`;
  const studio = String((lead && lead.name) || '').trim();
  return studio ? `Hi ${studio} team,` : 'Hi,';
}

function appName(lead) {
  const t = String((lead && lead.top_app) || '').trim();
  return t || 'your app';
}

/** The meeting ask, phrased for the situation, using the calendar link if set. */
function meetingAsk(lineIn) {
  const url = config.brand.calendarUrl;
  const has = url && String(url).indexOf('<<') === -1 && String(url).trim() !== '';
  const line = lineIn || 'Would a quick 15 minutes work?';
  // A lead-in ending in a comma is the first half of a sentence, so the rest has
  // to continue it in lower case. Otherwise we get "...talk it through, Send me
  // a couple of times", which reads like two sentences glued together.
  const cont = /,\s*$/.test(line);
  const tail = has
    ? `you can grab a slot straight from my calendar here: <a href="${url}">${url}</a>`
    : `send me a couple of times that suit you and I'll work around them.`;
  return `${line} ${cont ? tail : tail.charAt(0).toUpperCase() + tail.slice(1)}`;
}

const templates = {
  interested(lead) {
    return `${greeting(lead)}<br><br>` +
      `That's great to hear, thank you for coming back to me.<br><br>` +
      meetingAsk('Would a quick 15 minutes this week or next work? I\'ll walk you through how we ' +
        'value an app like ' + appName(lead) + ' and what the process looks like, with no obligation either way.') +
      `<br><br>` +
      `If you'd rather skip the call and just get to a number, that works too. ` +
      diligenceRequest({ opener: 'We can start the review straight away.' });
  },

  price_first(lead) {
    return `${greeting(lead)}<br><br>` +
      `Fair question, and I'd rather give you a real number than a made-up one. ` +
      `Here's how we get to it.<br><br>` +
      diligenceRequest({
        opener: 'We\'d like to take a proper look at ' + appName(lead) + ' and come back with a figure.'
      }) +
      `<br><br>` + meetingAsk('If you\'d rather talk it through first,');
  },

  send_info(lead) {
    // They asked what we need, so answer it and nothing else - an extra
    // preamble in front of "here is exactly what we need" only delays it.
    return `${greeting(lead)}<br><br>` +
      diligenceRequest({}) +
      `<br><br>` + meetingAsk('And if it\'s quicker to talk any of this through,');
  },

  who_are_you(lead) {
    const b = config.brand;
    const site = b.website && String(b.website).indexOf('<<') === -1 ? String(b.website) : '';
    return `${greeting(lead)}<br><br>` +
      `Of course, you should check before sharing anything.<br><br>` +
      `I'm ${b.ownerName} from ${b.legalName}. We buy and grow mobile apps - usually ones with ` +
      `real users that aren't being monetised anywhere near their potential, which is why ` +
      `${appName(lead)} caught my eye.` +
      (site ? ` You can look us up at <a href="${site}">${site.replace(/^https?:\/\//, '')}</a>.` : '') +
      `<br><br>${reviewIsEasy()} And we're happy to sign an NDA before you share anything at all - ` +
      `say the word and we'll send one over today.<br><br>` +
      meetingAsk('Happy to answer anything else first, on email or on a call -');
  },

  already_in_talks(lead) {
    return `${greeting(lead)}<br><br>` +
      `Understood, and thanks for being straight with me.<br><br>` +
      `If the process is still open, I'd like to be in it. It costs you nothing to have one ` +
      `more number to compare against, and we're fast.<br><br>` +
      diligenceRequest({
        opener: 'We can start today and come back with a figure inside a week.'
      }) +
      `<br><br>` +
      meetingAsk('And if it\'s worth 15 minutes to hear how we\'d approach it before you decide,') +
      `<br><br>If it's already too far along, no hard feelings - just say so and I'll leave you to it.`;
  },

  later(lead) {
    return `${greeting(lead)}<br><br>` +
      `That makes sense, and there's no rush from my side.<br><br>` +
      `Tell me roughly when is better and I'll come back to you then rather than pestering you ` +
      `in between.<br><br>` +
      `${reviewIsEasy()} So whenever you do want a number on ${appName(lead)}, it's a short job ` +
      `rather than a project - and it's worth having even if you never sell.<br><br>` +
      meetingAsk('If you\'d rather start with a quick call whenever the timing suits,');
  },

  wrong_person(lead) {
    return `${greeting(lead)}<br><br>` +
      `Apologies for landing in the wrong inbox, and thank you for telling me.<br><br>` +
      `Would you be able to point me to whoever looks after ${appName(lead)} now? ` +
      `A name or an address is plenty - or feel free to just forward this on.<br><br>` +
      `Thanks for your help.`;
  },

  already_sold(lead) {
    return `${greeting(lead)}<br><br>` +
      `Thanks for letting me know, and congratulations on the exit.<br><br>` +
      `If you're building something new, or you still hold anything else in the store, ` +
      `I'd be glad to hear about it - we're always looking. And if you'd ever want a second ` +
      `opinion on a valuation down the line, just reply here.<br><br>` +
      `All the best with what's next.`;
  },

  not_selling(lead) {
    return `${greeting(lead)}<br><br>` +
      `Understood, and thanks for replying rather than leaving me guessing.<br><br>` +
      `I'll leave it there and won't chase you. If anything changes with ${appName(lead)}, ` +
      `this year or in three years, just reply to this email and we'll pick it up.<br><br>` +
      `Best of luck with it.`;
  },

  unclear(lead) {
    return `${greeting(lead)}<br><br>` +
      `Thanks for getting back to me.<br><br>` +
      `Two easy ways forward, whichever suits you better.<br><br>` +
      meetingAsk('One, a quick 15 minutes where I explain how we value an app like ' +
        appName(lead) + ' and you decide if it\'s worth taking further.') +
      `<br><br>Two, we skip straight to the numbers. ` +
      diligenceRequest({ opener: 'We take a proper look and come back with a figure inside a week.' });
  }
};

/**
 * Replies sign off as the legal entity, not with the job title used on the cold
 * email. By this point the conversation is about a transaction, and
 * "Publishing Manager" is a leftover from the earlier publishing-program pitch
 * that reads as a contradiction next to an acquisition offer.
 */
function replySignature() {
  const b = config.brand;
  const lines = ['Thanks,', `<b>${b.ownerName}</b>`, b.legalName];
  if (b.ownerEmail) lines.push(b.ownerEmail);
  if (b.phone && String(b.phone).indexOf('<<') === -1 && String(b.phone).trim()) lines.push(b.phone);
  return '<br><br>' + lines.join('<br>');
}

// Intents where pushing for a meeting would be the wrong move.
const NO_PUSH = new Set(['not_selling', 'wrong_person', 'already_sold']);

/**
 * Draft the reply to send back to a lead.
 * Returns { intent, label, why, subject, html, pushesForMeeting }.
 * `intentOverride` lets the operator pick a different angle by hand.
 */
function draft(lead, replyText, intentOverride) {
  const found = classify(replyText);
  const intent = (intentOverride && templates[intentOverride]) ? intentOverride : found.intent;
  const meta = intentOverride && intentOverride !== found.intent
    ? { intent, label: labelFor(intent), why: 'Chosen by hand, overriding "' + found.label + '"' }
    : found;

  const base = String((lead && lead.reply_subject) || '').trim() ||
    ('Interested in ' + appName(lead));
  const subject = /^re:/i.test(base) ? base : 'Re: ' + base;

  return {
    ...meta,
    detected: found.intent,
    subject,
    html: templates[intent](lead || {}) + replySignature(),
    pushesForMeeting: !NO_PUSH.has(intent)
  };
}

function labelFor(intent) {
  const r = RULES.find((x) => x.intent === intent);
  if (r) return r.label;
  return intent === 'unclear' ? 'Unclear' : intent;
}

/** Every angle the operator can pick from, for the dashboard dropdown. */
function intents() {
  return Object.keys(templates).map((intent) => ({ intent, label: labelFor(intent) }));
}

module.exports = { classify, draft, intents, ACCESS, QUESTIONS, diligenceRequest, labelFor };
