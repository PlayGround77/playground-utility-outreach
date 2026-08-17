'use strict';

/**
 * Claude-written replies.
 *
 * The rule-based drafts in replydraft.js pick one of ten pre-written emails by
 * regex. That is predictable and free, but it cannot answer what someone
 * actually wrote - "we're open to it but prefer to keep everything in writing
 * and we already have an offer" is three things at once, and no template covers
 * the combination.
 *
 * This module sends the real conversation to Claude and gets back a reply
 * written for that specific message. The templates stay as the fallback: no API
 * key, an outage, or a malformed response and the caller silently gets the
 * rule-based draft instead. Losing the AI must never mean losing the ability to
 * answer a lead.
 *
 * Two things are deliberately NOT delegated to the model:
 *   - Sending. Every draft is shown for review and editing first, same as before.
 *   - The house rules. What we ask for, what we never ask for, the no-em-dash
 *     rule, and never using a guessed contact name are stated as constraints in
 *     the system prompt rather than left to taste.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const db = require('./db');
const people = require('./people');
const { todayStamp } = require('./time');

const MODEL = 'claude-opus-5';
const DAILY_CAP = 300;          // backstop against a runaway loop
const MAX_TOKENS = 4000;
// A person is waiting on a page load, so bound the worst case. The SDK retries
// twice by default, which turns an outage into a multi-minute hang before the
// template fallback appears; one retry and a 60s ceiling keeps that tolerable.
const TIMEOUT_MS = 60000;
const MAX_RETRIES = 1;

const KEY_SETTING = 'anthropic_api_key';

/**
 * A key saved from the dashboard wins over the environment variable.
 *
 * That is the same precedence as every other setting in this app (see
 * livemode.js): env vars are first-boot defaults, the settings table is
 * authoritative, and changing behaviour never needs a redeploy. The dashboard
 * says which of the two is actually in use, because a key that silently loses
 * to a stale Railway variable is a genuinely confusing failure.
 */
async function apiKey() {
  const fromDb = String(await db.getSetting(KEY_SETTING, '')).trim();
  if (fromDb) return fromDb;
  return String(process.env.ANTHROPIC_API_KEY || '').trim();
}

async function isEnabled() {
  return !!(await apiKey());
}

/** Show a key without revealing it: source, and the last four characters. */
async function keyStatus() {
  const fromDb = String(await db.getSetting(KEY_SETTING, '')).trim();
  const fromEnv = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const inUse = fromDb || fromEnv;
  return {
    set: !!inUse,
    source: fromDb ? 'dashboard' : (fromEnv ? 'env' : ''),
    // Both present is worth surfacing: the dashboard one wins and the Railway
    // variable is doing nothing.
    shadowsEnv: !!fromDb && !!fromEnv,
    hint: inUse ? '…' + inUse.slice(-4) : ''
  };
}

async function setKey(value) {
  await db.setSetting(KEY_SETTING, String(value || '').trim());
}

/**
 * Spend a few tokens proving the key actually works.
 * The wire format is verified by tests, but only a real call proves the key is
 * valid, the model is reachable, and the account has credit.
 */
async function testKey() {
  const key = await apiKey();
  if (!key) return { ok: false, error: 'no key set' };
  try {
    const client = new Anthropic({ apiKey: key, timeout: 30000, maxRetries: 1 });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }]
    });
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { ok: true, model: res.model || MODEL, said: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function underCap() {
  const n = Number(await db.getSetting('ai_calls_' + todayStamp(), '0'));
  return n < DAILY_CAP;
}
async function countCall() {
  const key = 'ai_calls_' + todayStamp();
  const n = Number(await db.getSetting(key, '0'));
  await db.setSetting(key, String(n + 1));
}

/* ------------------------------------------------------------------ prompt */

// What the reply must achieve and what it must never do. These are house rules,
// not suggestions - the model is told to treat them as constraints.
function systemPrompt() {
  const b = config.brand;
  return `You write replies on behalf of ${b.legalName}, which buys and grows mobile apps.
${b.ownerName} is the person writing. You are drafting a reply to a developer or studio
who answered a cold email about acquiring their app.

GOALS, in order:
1. Get a short call with whoever can actually decide to sell.
2. If they would rather not meet, get view-only access to the app's numbers so we
   can come back with an indicative offer in writing.

Do not push for a meeting when the reply says they are not selling, that we have
the wrong person, or that the app is already sold. In those cases: answer
gracefully, ask for an introduction if it is the wrong person, and leave the door
open. Never argue with a no.

HOW OUR REVIEW WORKS, when you need to describe it:
- It is view-only access, not a data pack. There is nothing for them to prepare -
  we pull the numbers ourselves.
- We come back with a number within a week.
- We ask them to invite ${b.ownerEmail} to: App Store Connect ("Sales" role);
  Google Play Console (this app only, with view app info / financial data / app
  quality); RevenueCat or Adapty or whatever they use for subscriptions, read
  only; and their ad accounts if they run any.
- Nothing sensitive at this stage: no keys, no passwords, no ownership changes.
  That comes later and only if we sign.
- Only four questions, because access answers everything else: monthly costs
  (API, hosting, anything recurring); whether any growth is paid and the monthly
  spend; who legally owns the code and assets; and the reason for selling.
- We are happy to sign an NDA first, and should offer it whenever they seem
  cautious.

HARD RULES:
- Only short hyphens (-). Never an em dash or en dash. This is not negotiable.
- Do not invent facts: no made-up valuations, past deals, client names, team
  size, or numbers we were not given. If you do not know something, say we can
  cover it on a call.
- Never state a price or a range. We price only after seeing the numbers.
- Do not promise anything legally binding.
- Plain sentences. No corporate filler, no "I hope this email finds you well",
  no exclamation marks, no emoji.
- Short. Usually under 200 words unless they asked several questions.
- Answer what they actually asked before steering anywhere.
- Sign off exactly as:
Thanks,
${b.ownerName}
${b.legalName}
${b.ownerEmail}

Write the body as plain text. Use a blank line between paragraphs. If you list
things, put each on its own line starting with "- " or "1. ". No markdown
headers, no bold, no HTML.`;
}

/** Everything we know about the lead, as a compact block for the model. */
function leadContext(lead) {
  const l = lead || {};
  const verifiedName = l.contact_name_source === 'site' ? l.contact_name : '';
  const lines = [
    `Studio: ${l.name || 'unknown'}`,
    `App we approached them about: ${l.top_app || 'unknown'}`,
    l.country ? `Based in: ${l.country}` : '',
    `Their email: ${l.email || 'unknown'}`,
    verifiedName
      ? `Contact name (verified from their website - safe to use): ${verifiedName}`
      : (l.contact_name
        ? `A name was GUESSED from their email address (${l.contact_name}) but is NOT verified - do NOT address them by it. Greet the studio instead.`
        : 'No contact name known - greet the studio, e.g. "Hi <studio> team,".'),
    l.outreach ? `Where the sequence stands: ${l.outreach}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * The conversation so far, oldest first, with the message to answer marked.
 * Without the marker a long thread invites the model to reply to whichever part
 * it finds most interesting rather than to what they just said.
 */
function threadBlock(thread, fallbackSnippet) {
  if (thread && thread.length) {
    const lastTheirs = thread.map((m) => m.fromUs).lastIndexOf(false);
    return thread.map((m, i) => {
      const tag = m.fromUs ? 'US' : 'THEM';
      const mark = (i === lastTheirs)
        ? '  <<< THIS IS THEIR LATEST MESSAGE - ANSWER THIS ONE'
        : '';
      return `--- ${tag} (${m.date || 'no date'})${mark} ---\n${m.text}`;
    }).join('\n\n');
  }
  const s = String(fallbackSnippet || '').trim();
  return s
    ? `--- THEM (only the opening of the message was captured) ---\n${s}`
    : '(No reply text could be retrieved. Say so rather than guessing what they wrote.)';
}

const SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description: 'Short label for what they want, e.g. "wants a number first", "not selling", "asking who we are".'
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences: what they actually said, and the angle you took. For the operator, not the recipient.'
    },
    pushesForMeeting: {
      type: 'boolean',
      description: 'True if the draft asks for a call. False for not-selling, wrong-person and already-sold replies.'
    },
    subject: { type: 'string', description: 'Subject line, normally "Re: " + their subject.' },
    body: { type: 'string', description: 'The reply, plain text, including the sign-off.' }
  },
  required: ['intent', 'reasoning', 'pushesForMeeting', 'subject', 'body'],
  additionalProperties: false
};

/* ------------------------------------------------------------------- draft */

/**
 * Ask Claude for a reply.
 * Returns { ok, intent, reasoning, pushesForMeeting, subject, body, error }.
 * Never throws - on any failure `ok` is false and the caller falls back.
 */
async function draftReply({ lead, thread, replySnippet, instruction }) {
  const key = await apiKey();
  if (!key) return { ok: false, error: 'no ANTHROPIC_API_KEY set' };
  if (!(await underCap())) return { ok: false, error: 'daily AI call cap reached' };

  const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });

  const userContent =
    `Here is the lead:\n\n${leadContext(lead)}\n\n` +
    `Here is the email conversation so far, oldest message first:\n\n${threadBlock(thread, replySnippet)}\n\n` +
    `Reply to their LATEST message. Earlier messages are context - do not answer ` +
    `points that were already settled, and do not repeat what we have already told them.\n\n` +
    (instruction
      ? `The operator wants this specific angle, and it overrides your own judgement so long as it does not break the hard rules:\n${instruction}\n\n`
      : '') +
    `Write the reply.`;

  try {
    await countCall();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SCHEMA }
      },
      system: systemPrompt(),
      messages: [{ role: 'user', content: userContent }]
    });

    if (res.stop_reason === 'refusal') {
      return { ok: false, error: 'the model declined to answer this one' };
    }
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text.trim()) return { ok: false, error: 'empty response' };

    let out;
    try { out = JSON.parse(text); }
    catch (e) { return { ok: false, error: 'could not parse the response' }; }
    if (!out || !out.body) return { ok: false, error: 'response had no body' };

    return {
      ok: true,
      intent: String(out.intent || '').slice(0, 120),
      reasoning: String(out.reasoning || '').slice(0, 600),
      pushesForMeeting: !!out.pushesForMeeting,
      subject: String(out.subject || '').slice(0, 200),
      body: sanitize(String(out.body)),
      usage: res.usage || null
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/* --------------------------------------------------------------- transforms */

/**
 * Editing tools for a draft that already exists: change the tone, the length or
 * the language, rephrase one selected sentence, or translate their message into
 * something you can read.
 *
 * The split that matters: everything that rewrites OUR reply inherits the house
 * rules, so a friendlier tone can't invent a price or slip in an em dash.
 * Translating THEIR message is the exception - it is their text, and a faithful
 * translation is the whole point, so the house rules are deliberately not
 * applied to it.
 */
const TONES = {
  professional: 'More professional and businesslike, without becoming stiff or corporate.',
  friendly: 'Warmer and more personable, like writing to someone you like. Still concise.',
  direct: 'Blunter and shorter. Cut hedging and pleasantries, lead with the point.',
  warm: 'More appreciative and encouraging about what they have built, without flattery.',
  firm: 'Firmer and more confident, making clear what we need to move forward. Never rude.',
  apologetic: 'Acknowledge the friction or the mistake, briefly and without grovelling.',
  enthusiastic: 'More visibly interested and energetic about their app. No exclamation marks.'
};

const LENGTHS = {
  shorter: 'Cut it to roughly half the length. Keep every substantive point, drop the padding.',
  longer: 'Expand it a little: explain the reasoning behind what we are asking for. Stay under 300 words.'
};

const HOUSE = `Keep every hard rule: only short hyphens (-), never an em or en dash; invent no
facts, numbers, deals or names; never state a price or a range; no corporate filler and no emoji;
keep the same sign-off. Do not answer anything the original draft did not answer.`;

/** What to ask for, per action. Returns null for an unknown action. */
function transformBrief({ kind, option, selection }) {
  if (kind === 'tone') {
    const t = TONES[option];
    return t && `Rewrite the reply below in this register: ${t}\n\n${HOUSE}`;
  }
  if (kind === 'length') {
    const l = LENGTHS[option];
    return l && `Rewrite the reply below. ${l}\n\n${HOUSE}`;
  }
  if (kind === 'language') {
    const lang = String(option || '').trim();
    return lang && `Rewrite the reply below entirely in ${lang}, as a fluent native speaker would ` +
      `write it - a natural business email, not a literal translation. Keep names, the company ` +
      `name and email addresses as they are.\n\n${HOUSE}`;
  }
  if (kind === 'rephrase') {
    if (!selection) return null;
    return `Below is a reply, and one passage from it marked out. Rewrite ONLY that passage. ` +
      `It must drop into the same place and read naturally with the sentences around it. ` +
      `Return only the replacement passage - no quotes, no preamble, no surrounding text.\n\n` +
      `The passage to rewrite:\n"""${selection}"""\n\n${HOUSE}`;
  }
  if (kind === 'custom') {
    const note = String(option || '').trim();
    return note && `Rewrite the reply below according to this instruction: ${note}\n\n${HOUSE}`;
  }
  if (kind === 'translate') {
    const lang = String(option || 'English').trim() || 'English';
    // Their words, not ours - translate faithfully rather than improving it.
    return `Translate the message below into ${lang}. Translate faithfully, including the tone ` +
      `and any hedging: do not summarise, soften, or answer it. If it is already in ${lang}, ` +
      `return it unchanged. Return only the translation.`;
  }
  return null;
}

const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The rewritten text, plain, no quotes around it.' } },
  required: ['text'],
  additionalProperties: false
};

/**
 * Run one editing action. Returns { ok, text, error } and never throws.
 * `text` is the whole rewritten draft, except for 'rephrase' where it is just
 * the replacement for the selected passage.
 */
async function transform({ kind, option, text, selection, lead }) {
  const key = await apiKey();
  if (!key) return { ok: false, error: 'no ANTHROPIC_API_KEY set' };
  if (!(await underCap())) return { ok: false, error: 'daily AI call cap reached' };

  const brief = transformBrief({ kind, option, selection });
  if (!brief) return { ok: false, error: 'unknown or incomplete action' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'nothing to work on' };

  const isOurs = kind !== 'translate';
  const system = isOurs
    ? systemPrompt() + `\n\nYou are now EDITING an existing draft rather than writing a new one. ` +
      `Change only what the instruction asks for and leave the substance alone.`
    : `You are a translator. Translate accurately and idiomatically. Never add commentary.`;

  const user = brief + '\n\n' +
    (isOurs && lead ? `Context on the lead, for names and facts only:\n${leadContext(lead)}\n\n` : '') +
    `---\n${body}\n---`;

  const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  try {
    await countCall();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TEXT_SCHEMA } },
      system,
      messages: [{ role: 'user', content: user }]
    });
    if (res.stop_reason === 'refusal') return { ok: false, error: 'the model declined this one' };

    const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let out;
    try { out = JSON.parse(raw); } catch (e) { return { ok: false, error: 'could not parse the response' }; }
    if (!out || typeof out.text !== 'string' || !out.text.trim()) {
      return { ok: false, error: 'empty response' };
    }
    // Their translated words keep their own punctuation; ours get scrubbed.
    return { ok: true, text: isOurs ? sanitize(out.text) : out.text.trim() };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * Last line of defence on the house style. The model is told not to use em or en
 * dashes, but this is an explicit owner requirement for anything a recipient
 * sees, so it is enforced here too rather than trusted.
 */
function sanitize(body) {
  return body
    .replace(/\s*[—–]\s*/g, ' - ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  draftReply, transform, transformBrief, isEnabled, keyStatus, setKey, testKey,
  systemPrompt, leadContext, threadBlock, sanitize,
  TONES, LENGTHS, MODEL, DAILY_CAP, KEY_SETTING
};
