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

// What we need to value an app. The short list is what goes to someone who is
// lukewarm: four questions is answerable in one sitting, ten is a chore that
// gets postponed forever. The full list goes to someone who asked what we need.
const ASK_SHORT = [
  'Revenue for the last 12 months, split by source (in-app purchases, subscriptions, ads)',
  'Installs and current active users (daily and monthly)',
  'Monthly running costs - servers, third-party services, any licences',
  'Roughly how many hours a month it takes to keep it running, and who does that'
];

const ASK_FULL = [
  'Revenue for the last 12 months, split by source (in-app purchases, subscriptions, ads)',
  'Installs for the last 12 months, and current daily and monthly active users',
  'Retention - day 1, day 7 and day 30 if you have it',
  'Where the traffic comes from: organic versus paid, and any current ad spend',
  'Monthly running costs - servers, third-party services, any licences',
  'Roughly how many hours a month it takes to keep it running, and who does that',
  'A screenshot or CSV export from Play Console / App Store Connect covering the above',
  'Account standing - any policy strikes, warnings or appeals, past or open',
  'What would be included in a sale: source code, assets, the developer account, the app name and any trademark',
  'What kind of price you have in mind'
];

function askList(items) {
  return '<ul style="margin:.4rem 0 .4rem 1.1rem;padding:0">' +
    items.map((i) => `<li style="margin:.25rem 0">${i}</li>`).join('') + '</ul>';
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
  return has
    ? `${line} You can grab a slot straight from my calendar here: <a href="${url}">${url}</a>`
    : `${line} Send me a couple of times that suit you and I'll work around them.`;
}

/** The fallback ask: if they will not meet, get the numbers instead. */
function dataFallback(items) {
  return 'If you would rather not get on a call, that is completely fine - just send these over ' +
    'and I can come back with an indicative number in writing:' + askList(items || ASK_SHORT);
}

const templates = {
  interested(lead) {
    return `${greeting(lead)}<br><br>` +
      `That's great to hear, thank you for coming back to me.<br><br>` +
      `The quickest way forward is a short call: I'll tell you how we value an app like ` +
      `${appName(lead)}, what the process looks like, and you can decide if it's worth ` +
      `taking further. No obligation either way.<br><br>` +
      meetingAsk('Would a quick 15 minutes this week or next work?') + '<br><br>' +
      `So the call is useful rather than exploratory, it helps if I have these in advance:` +
      askList(ASK_SHORT);
  },

  price_first(lead) {
    return `${greeting(lead)}<br><br>` +
      `Fair question, and I'd rather give you a real number than a made-up one.<br><br>` +
      `What an app like ${appName(lead)} is worth comes down to a few things I can't see from ` +
      `the outside - how the revenue is actually made up, how users retain, and how much of the ` +
      `traffic is organic. Send me these and I'll come back with an indicative range in writing:` +
      askList(ASK_SHORT) +
      `<br>Or if it's easier, give me 15 minutes on a call and I'll walk you through how we get ` +
      `to a number, so you can judge whether we're in the right area at all.<br><br>` +
      meetingAsk('');
  },

  send_info(lead) {
    return `${greeting(lead)}<br><br>` +
      `Thanks - here's exactly what I need. Rough figures are fine at this stage; ` +
      `I'm not expecting anything audited:` +
      askList(ASK_FULL) +
      `<br>Send whatever you have to hand and I'll work with it. Once I've read through, ` +
      `I'll come back with an indicative range.<br><br>` +
      meetingAsk('If it is quicker to talk it through, I am happy to do that instead -');
  },

  who_are_you(lead) {
    const b = config.brand;
    const site = b.website && String(b.website).indexOf('<<') === -1 ? String(b.website) : '';
    return `${greeting(lead)}<br><br>` +
      `Of course, you should check before sharing anything.<br><br>` +
      `I'm ${b.ownerName}, ${b.ownerTitle} at ${b.companyName}. We buy and grow mobile apps - ` +
      `usually ones with real users that aren't being monetised anywhere near their potential, ` +
      `which is why ${appName(lead)} caught my eye.` +
      (site ? ` You can look us up at <a href="${site}">${site.replace(/^https?:\/\//, '')}</a>.` : '') +
      `<br><br>Happy to answer anything else before you share numbers. A short call is usually the ` +
      `fastest way to work out whether this is worth either of our time.<br><br>` +
      meetingAsk('') + '<br><br>' +
      `And if you would rather size it up without a call, send these over and I'll come back ` +
      `with an indicative range in writing:` + askList(ASK_SHORT);
  },

  already_in_talks(lead) {
    return `${greeting(lead)}<br><br>` +
      `Understood, and thanks for being straight with me.<br><br>` +
      `If the process is still open, I'd like to be in it. We can move quickly, and it costs ` +
      `you nothing to have one more number to compare against.<br><br>` +
      `Send me these and I'll come back with an indicative range fast:` +
      askList(ASK_SHORT) +
      `<br>` + meetingAsk('Or if you would rather talk it through,') + `<br><br>` +
      `And if it's already too far along, no hard feelings - just let me know and I'll leave you to it.`;
  },

  later(lead) {
    return `${greeting(lead)}<br><br>` +
      `That makes sense, and there's no rush from my side.<br><br>` +
      `Two things so this doesn't get lost. First, tell me roughly when is better and I'll come ` +
      `back to you then rather than pestering you in between. Second, if you'd like a sense of ` +
      `what ${appName(lead)} might be worth in the meantime, send these over and I'll put a ` +
      `range together - no commitment, and it's useful to have even if you never sell:` +
      askList(ASK_SHORT) +
      `<br>` + meetingAsk('And if a short call is easier than email,');
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
      `To keep this simple, there are two easy ways forward. Either a quick 15-minute call, ` +
      `where I'll explain how we value an app like ${appName(lead)} and you can decide if it's ` +
      `worth taking further. Or, if you'd rather not get on a call, send me these and I'll come ` +
      `back with an indicative number in writing:` +
      askList(ASK_SHORT) +
      `<br>` + meetingAsk('');
  }
};

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

  const signature = require('./templates').signature();
  const base = String((lead && lead.reply_subject) || '').trim() ||
    ('Interested in ' + appName(lead));
  const subject = /^re:/i.test(base) ? base : 'Re: ' + base;

  return {
    ...meta,
    detected: found.intent,
    subject,
    html: templates[intent](lead || {}) + signature,
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

module.exports = { classify, draft, intents, ASK_SHORT, ASK_FULL, labelFor };
