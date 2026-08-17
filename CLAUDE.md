# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app does

Automated cold-outreach pipeline that hunts **undervalued, under-monetized mobile apps to acquire**
(AppStoreSpy → Postgres → Gmail), with a web dashboard for review and sending. Deployed on Railway.

> **The README, SETUP.md and docs/SYSTEM.md are partly stale.** They still describe the earlier
> "recruit studios into a publishing program" pitch and Gmail SMTP/IMAP with an app password.
> The code is the source of truth: the funnel and email copy are now **acquisition**-oriented, and
> email goes over the **Gmail API (OAuth/HTTPS)**. `apps-script/` is a dead legacy implementation.

## Commands

```bash
npm start                     # run everything: web dashboard + cron scheduler
npm run test:appstorespy      # sourcing self-test, end-to-end (costs ~2 AppStoreSpy credits)

node src/jobs/refill.js --force   # force one sourcing run (see gotcha below)
node src/jobs/sender.js           # one send pass
node src/jobs/replywatcher.js     # one reply/bounce scan
node src/jobs/summary.js          # one daily summary
```

Each job in `src/jobs/` is runnable standalone via its `require.main` block.

**There is no test framework and no linter.** Verify changes with `node --check <file>` plus a real
run against a throwaway Postgres:

```bash
PGDIR=/tmp/pgtest; rm -rf $PGDIR; mkdir -p $PGDIR; chown postgres $PGDIR; chmod 700 $PGDIR
BIN=$(ls -d /usr/lib/postgresql/*/bin | head -1)
su postgres -c "$BIN/initdb -D $PGDIR -A trust -U postgres" >/dev/null
su postgres -c "$BIN/pg_ctl -D $PGDIR -o '-p 55432 -k /tmp' -l /tmp/pg.log start"
su postgres -c "$BIN/psql -p 55432 -h /tmp -U postgres -c 'CREATE DATABASE outreach;'"
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/outreach"
export DRY_RUN=true GMAIL_USER=x@y.com DASHBOARD_PASS=secret PORT=3999
# ...then node src/index.js, curl -u admin:secret localhost:3999/, etc.
su postgres -c "$BIN/pg_ctl -D $PGDIR stop"; rm -rf $PGDIR
```

To exercise send paths without credentials, stub the mailer before requiring the sender:
`require('./src/email').send = async () => ({ messageId: '<x@y>', threadId: 't' })`.

## Architecture

### Runtime state lives in Postgres, not env vars

This is the central design fact. `src/config.js` reads env vars, but those are only **first-boot
defaults**. Anything operationally meaningful is stored in the `settings` table and edited from the
dashboard, so changing behavior never requires a redeploy:

| Setting key | Module | Meaning |
|---|---|---|
| `dry_run_override` | `src/livemode.js` | DRY vs LIVE. Falls back to `config.DRY_RUN` only if never toggled. |
| `send_mode` | read inline | `paused` \| `manual` \| `auto` |
| `criteria` (JSON) | `src/criteria.js` | all search criteria + `dailyQuotaOverride` |
| `last_watch_run` / `last_watch_status` | `src/jobs/replywatcher.js` | proof the reply scan actually ran |
| `anthropic_api_key` / `apify_token` | `src/ai.js` / `src/apify.js` | API keys, saved from the dashboard |

**API keys follow the same precedence as every other setting: a key saved in the dashboard beats the
env var.** `keyStatus()` reports which one is live and flags `shadowsEnv` when a Railway variable is
being silently overridden. Keys are write-only in the UI — only the last four characters are ever
rendered back. `POST /keys` validates the prefix (`sk-ant-` / `apify_api_`) so a wrong-service paste
fails immediately instead of surfacing later as an auth error, and `POST /keys/test` spends a few
tokens on a one-word request to prove the key actually works.

**Never read `config.DRY_RUN` directly** — always `await liveMode.isDry()`. Likewise `dailyQuota()`
in `src/jobs/sender.js` is **async** (it consults the criteria override before the warm-up ramp).

### Two independent gates before any email

`runSender()` checks `send_mode` first (scheduler only sends in `auto`; a manual "Send tick" is
refused while `paused`), then the send window/quota/bounce-brake, then `dry`. Per-lead `sendOne()`
bypasses window and quota by design (deliberate human action) but still honors dry, the guards, and
block status.

### Sourcing pipeline

`src/jobs/refill.js` orchestrates: `appstorespy.queryApps()` (one call per category/page) →
per-developer `getDeveloper()` → `buildCandidate()` → `guards.screenReason()` → `db.insertLead()`.

- The installs band is enforced **in the API query** (`downloads_daily`), not re-checked afterward —
  stored installs are developer-level totals, so re-checking would contradict itself.
- `opportunityScore()` in `src/appstorespy.js` (0–100) ranks leads: proven demand × weak monetization
  × cheap-to-acquire. **Leads are sorted and sent by `opportunity`, not `priority`.** `priority`
  (installs/day × app count) is a legacy "how big is this developer" number kept only as a tie-break
  — giants score in the billions there, so it is *not* a quality signal.
- Optional review-mining (`scanReviews` criterion) fetches reviews and boosts the score on buy-signal
  phrases ("too expensive", "should be free"). Costs an extra API call per keeper.

### Finding the human behind the app

AppStoreSpy has **no person name and no LinkedIn field** — `PlayDev` is
`name/email/url/total_apps/ipd/revenue/hq_country`, `PlayApp` is `emails/website/privacy_policy`.
So a contact name is *derived* and a LinkedIn profile is only ever *searched for*. The deliverable is
deliberately **a name plus enough context that a human recognises the right person** — not an
auto-resolved profile. A wrong match here means emailing a stranger about buying an app they have
nothing to do with.

| Module | Role |
|---|---|
| `src/people.js` | pure: `nameFromEmail()`, `looksLikePerson()`, `linkedinSearches()`, `countryName()` |
| `src/enrich.js` | reads the studio's own site (free) for a name / LinkedIn / better email |
| `src/apify.js` | optional paid lookup, `APIFY_TOKEN` — **not** a LinkedIn scraper (see below) |

- **`contact_name_source` is the trust marker.** `site` = read off their website (shown `✅`);
  `email` = split out of the address (shown `~`, a guess). **Guessed names never reach
  `src/templates.js`** — outreach still addresses the studio. This is deliberate, not an oversight.
- **The website fallback chain** (`buildCandidate`) is listed site → privacy-policy host → email
  domain, so enrichment has a domain to read. But `opportunityScore()` is passed the **listed site
  only**: "Play lists no website" is the solo-dev signal, and a domain we inferred is not evidence
  of one. Keep those two arguments distinct.
- **`enrichFromSite` is ON by default** (criteria flag; set `ENRICH_FROM_SITE=false` to disable). The
  studio's own site is where the LinkedIn link and the founder's name actually live, and reading it
  costs no API credits. It is wrapped in `try/catch` in `refill.js` — enrichment failing must never
  break a sourcing run — and has its own daily fetch cap, 8s timeout, 1MB body cap, redirect cap and
  robots.txt check, because unlike AppStoreSpy these are arbitrary third-party servers.
- **The crawl follows real links, it does not guess paths.** It reads the homepage, then queues the
  same-origin About/Team/Contact links that page actually contains (`findInternalLinks`), falling
  back to a short fixed list only when it finds none. That costs no 404s and catches `/our-story` or
  `/about-tiimo`, which a fixed list never would. robots.txt is fetched **once per site**, and the
  page budget counts *attempts* rather than successes so a one-page site cannot burn it on 404s.
- **`findLinkedIn` prefers a `/in/` profile over a `/company/` page**, and trims subpaths — a footer
  link to `linkedin.com/company/tiimo-aps/about/` is stored as the profile URL itself.
- **A phone is only ever taken from something published *as* a phone number**: a `tel:` link
  (`phone_source='tel'`), a `Phone:`/`Tel:`/`Mobile:` label in the copy (`'text'`), or the store's
  developer contact (`'store'`). There is deliberately **no bare digit-run fallback** — a page is
  full of digit runs (VAT and company numbers, dates, prices, postcodes, order IDs) and a wrong
  number means cold-calling a stranger, the same reasoning that keeps guessed names out of outreach.
  `people.normalisePhone()` is the single validator (7–15 digits, `00`→`+`, placeholders rejected);
  `displayPhone()` keeps **their** formatting, because we do not know where the country code ends
  and any regrouping we invented would read worse than the spacing they chose. Only the `tel:` href
  is normalised.
- **A name must not run into the next field's label.** Stripping tags turns
  `<p>Founder: Marta Nowak</p><p>Phone: …</p>` into one run of text, so `NAME` rejects a trailing
  word followed by a colon — with a `\b` before the lookahead, or the engine dodges it by matching
  `Phon` and leaving `e:`.
- **Regexes in `enrich.js` must not carry the `/i` flag.** Capitalisation is the only thing
  separating a name from surrounding prose; `/i` makes `[A-Z]` match lowercase, which swallows the
  next word *and* backtracks catastrophically on a big page. Role keywords spell out their own case
  via `ci()`. Likewise the email regex bounds its local part — an unbounded `+` before `@` is
  quadratic on a long run with no `@` (this hung the test suite for 90s+ before it was bounded).
- **`src/apify.js` runs Apify's Google Search Scraper** against `site:linkedin.com/in "<name>"`,
  not a LinkedIn scraper: cheaper, far more stable (LinkedIn actively blocks scrapers), and it never
  requests anything from LinkedIn. It returns *ranked candidates*, and it is opt-in and daily-capped
  because it costs money per call. **Its request shape has not been verified against the live API** —
  the dev sandbox's egress policy blocks `api.apify.com`.

### Answering a reply

**`src/ai.js` writes the reply with Claude; `src/replydraft.js` is the fallback.**
`draftSmart()` calls the Claude API (`claude-opus-5`, adaptive thinking, structured output) with
the *full Gmail thread* and the lead's context, and drops to the rule-based templates whenever the
AI is unavailable — no `ANTHROPIC_API_KEY`, over the daily cap, network error, refusal, unparseable
response. The dashboard shows which engine produced the draft. Losing the AI must never mean losing
the ability to answer a lead, so **never make the template path unreachable**.

- **The model gets the whole conversation, not the snippet.** `email.fetchThread()` pulls the real
  message bodies (walking the MIME tree, preferring `text/plain`, stripping quoted history). The
  500-char `reply_snippet` is only a fallback when the thread cannot be read. `threadBlock()` marks
  their newest message so a long thread does not invite the model to answer the wrong part.

### Whose turn is it

**`last_inbound_at` vs `last_outbound_at` is the whole model.** A conversation needs an answer when
their last message is newer than ours. Flags cannot express this: someone who writes again after we
replied is the case that matters most, and a first-reply-only test misses it entirely.

- `replywatcher.js` treats "new" as *newer by timestamp*, not "first reply ever", and picks the
  newest inbound message by comparing `internalDate` rather than trusting Gmail's list order.
- **It never overwrites `response`** after the first reply — that column is the operator's own
  status. A later message surfaces through the timestamps instead, so a "Booked a call" lead who
  writes again still appears in the waiting list.
- `POST /reply/:id/send` stamps `last_outbound_at`; without it the system cannot tell "waiting on
  them" from "waiting on you".
- **The reply watcher writes to the DB in dry mode.** DRY_RUN means no email leaves the building;
  reading the inbox and recording what was found is observation. It used to skip the writes, which
  left the dashboard blank on the one setting people test in. Only the alert email is gated.
- **`needsReply` is computed once, on the lead objects**, and drives the banner, the row stripe and
  the counts alike — one definition, not three.
- The row stripe hangs off the **pinned first cell**, because the Reply column scrolls out of view.

### The reply page loads in two stages

`GET /reply/:id` renders immediately with the rule-based draft; the browser then calls
`GET /reply/:id/ai` and swaps in Claude's version. Blocking the render on the model meant 10-40s of
blank tab. Two rules the swap must keep: it **never overwrites text the operator has already typed**
(it says so instead), and model output is escaped client-side before it reaches `innerHTML`.
- **House rules live in the system prompt as constraints, not suggestions**: the view-only access
  ask, no invented facts, never state a price, short hyphens only. `sanitize()` re-scrubs em/en
  dashes afterwards anyway, because that one is an explicit owner requirement.
- **A guessed contact name is explicitly flagged to the model as unsafe to use** — same rule as the
  templates, enforced in `leadContext()`.
- Request shape is verified against the real SDK wire format (a test points `ANTHROPIC_BASE_URL` at
  a local server and asserts the body): no `temperature`/`top_p`, no `budget_tokens`, no prefill —
  all of which 400 on Opus 5.
- **`ANTHROPIC_API_KEY` has never been exercised against the live API** — the dev sandbox has no key.
  The wire format is verified; the model's actual output is not.

The rule-based layer below still runs the classification and is what you get without a key.

`src/replydraft.js` reads the reply and drafts a matching answer. Every draft aims at the same two
outcomes in order: **get a call**, and failing that **get the app's numbers** so an indicative offer
can be made in writing. Three intents deliberately break that pattern and do not push for a meeting:
`not_selling`, `wrong_person`, `already_sold`.

- **Classification is rule-based and ordered, first match wins** (same convention as `guards.js`).
  Order matters: `wrong_person` must beat `interested` ("I'm not the owner but happy to chat") and
  `not_selling` must beat `interested` ("not interested") and `price_first` ("Not for sale. How much
  though?"). There are tests for exactly these traps.
- **It classifies Gmail's *snippet*, not the full body** (capped at 500 chars in `email.js`). The
  draft page shows the reply text and a link to the Gmail thread because of this.
- **The ask is for view-only console access, not for a data pack.** `diligenceRequest()` asks them to
  invite us to App Store Connect / Play Console / RevenueCat / ad accounts and says "there's nothing
  for you to prepare" — we pull the numbers ourselves. Only the four things access *cannot* show
  (costs, paid growth, who owns the code, why they're selling) are asked as questions. This is the
  owner's own copy and the wording is deliberate: homework gets postponed, four console invites get
  done the same evening. It also gets us the real numbers rather than their summary of them.
- **The ask is graduated.** Full request for `interested` / `price_first` / `send_info` /
  `already_in_talks` / `unclear`; only the one-line `reviewIsEasy()` framing for `who_are_you` and
  `later`, where asking for console access too early would kill it; nothing at all for the three
  no-push intents.
- **Replies sign off as `brand.legalName`** (`LEGAL_NAME`, default "Playground Studio LLC"), not with
  `ownerTitle` — "Publishing Manager" is a leftover from the old publishing pitch and contradicts an
  acquisition offer. `templates.js` (the cold emails) still uses the old signature.
- `meetingAsk()` lowercases its continuation when the lead-in ends in a comma, so a custom lead-in
  does not produce "...talk it through, Send me a couple of times".
- **The greeting only uses a `site`-verified contact name.** A name guessed from an email address
  falls back to the studio, same rule as the cold email — this is now a real conversation, so getting
  the name wrong is worse, not better.
- Sending goes through `POST /reply/:id/send`, which honours dry mode and `screenReason()` but is
  *not* `sendOne()` — that refuses any lead with a response set, which is every replied lead.
- **The operator edits plain text, never HTML.** `htmlToText()` renders the draft into the textarea
  and `textToHtml()` converts it back on send; lines starting `- ` or `1. ` become real lists and bare
  URLs are linked. The round trip is stable, and user text is HTML-escaped on the way back.
- **`form{display:inline}` is global in `server.js`.** Any form holding stacked content needs
  `class="stack"` or it gets no height and the next card renders on top of it.

### Editing the draft with the AI

`ai.transform({kind, option, text, selection, lead})` backs the toolbar above the reply textarea —
tone, shorter/longer, another language, a free-text instruction, rephrasing just a selection, and
translating one of *their* messages. One `POST /reply/:id/transform` route serves all of them and
returns `{ok, text}`; `transform()` never throws, so a dead API is a line of status text, not a lost
draft. It runs at `effort: 'low'` — these are edits, not fresh reasoning.

- **Everything that rewrites OUR reply inherits the house rules** (`HOUSE`, plus the full
  `systemPrompt()`), so "make it friendlier" cannot invent a price or slip in an em dash, and
  `sanitize()` scrubs the result anyway. **Translating THEIR message is the deliberate exception**:
  it is their text, a faithful translation is the whole point, and it gets a plain translator system
  prompt, no house rules, no `leadContext()`, and no dash-scrubbing.
- **The selection is a scope, not another action.** "Make it friendlier" and "make this sentence
  friendlier" are the same request with one extra argument, so `transformBrief()` splits into
  `actionBrief()` (what to do) and `scopedBrief()` (aim it at one marked passage). **Passing a
  `selection` changes the return value**: `transform()` then returns *only* the replacement, which
  the client splices back with `value.slice(0,s) + text + value.slice(e)` and leaves selected. Every
  tool inherits this; adding one does not mean adding a selection variant of it.
- The `t-scope` dropdown switches to the selection by itself when you highlight something, and back
  when you clear it. **The offsets are stashed on every selection change, not read at click time** —
  clicking a dropdown blurs the textarea. `rephrase` ignores the dropdown: highlighting is the whole
  gesture, and refusing it because a `<select>` says "whole reply" would just be confusing.
- Translation is a **toggle**: the original is stashed in `dataset.original` and the button flips to
  "↩ Show original". Never lose their real words behind a translation. It is also never scoped — a
  half-translated message is worse than an untranslated one.
- Unknown actions, an empty selection and an empty draft are all refused **before** the API call.

### Draft versions (Back / Forward)

Every AI change replaces the whole textarea, which wipes the browser's own undo stack — so the page
keeps its own labelled history: `Template draft → Claude's draft → your edit → shorter (passage)`.
The async Claude draft goes through `window.__draftVersion` rather than assigning to the box, or the
template it replaces would be unreachable.

- **Navigation is a step, not an index.** `captureEdit()` may append the operator's typing and move
  `hpos`, so a target worked out before it runs is stale — that landed you one version short of your
  own text when you pressed Back after typing and then Forward. `step(±1)` computes the target
  *after* the capture.
- Typing after a generated version is itself a version. Stepping away commits it first, so Back can
  never silently discard what you wrote.
- Running any tool sets `window.__draftEdited`, which the async draft checks alongside its own
  `touched` flag — otherwise a slow Claude draft would land on top of a rewrite you already made.

### Who spoke last

`needsReply` is derived from `last_inbound_at` vs `last_outbound_at`, so anything that answers a
lead **must** stamp `last_outbound_at` — otherwise the dashboard nags about a lead you already
answered. Replying from Gmail directly is the obvious way that happens, so there are two repairs:

- **`scanInbox()` also scans `in:sent`** and returns `sentByThread` (newest message per thread,
  compared by `internalDate` rather than trusting list order). The watcher adopts it **before** the
  "already seen" `continue`, so it also fixes historical rows. `gmail.readonly` already covers this —
  no re-consent. A failure there is logged and swallowed: losing the sent scan must not lose the
  reply scan.
- **Opening `/reply/:id` self-heals** from the fetched thread when its last message is `fromUs`.
  The thread is the authority on who spoke last; our own stamp is only a cache of it.

### The stat tiles are the filter

Each tile at the top links to `/?view=<key>`. The count on a tile and the rows you get when you
click it come from **one predicate**, in the `TILES` list in `src/server.js` — so a tile reading 130
can never open a list of 128. That was a live bug before: the Queue tile and the `view=queue` filter
disagreed about a lead in the Replied group. Adding a tile means adding one entry, not editing a
counting loop and a filter branch that must be kept in sync.

- `Sent today` counts **leads** (`db.leadIdsToday`), not send events like the quota line above it.
  A lead cannot be sent to twice in one day, so they agree — but the tile has to match its own list.
- Clicking a tile drops the search box and column filters on purpose: you clicked a total, so you
  should get that total.
- `.tile:hover` repeats `text-decoration:none` because the global `a:hover` rule is more specific
  than `.tile` and would underline the number and the label.

### The LinkedIn column

A **blue** LinkedIn icon is a real link — a profile or company page found on the studio's own site.
A **grey** one means nothing was found and opens ready-made searches instead. Never render a search
as if it were a resolved profile.

- **`.findbox` must be `position:fixed`, not `absolute`.** The table wrapper computes to
  `overflow-y:hidden`, which clips an absolutely-positioned panel — invisible *and unclickable* for
  rows low in the table. It is parked off-screen in CSS and placed by `place()` on open, flipping
  above the icon when there is no room below.
- **`openedAt` is stamped in the click handler, not in `toggle`.** `toggle` on `<details>` fires
  *asynchronously*, so the browser's own scroll-into-view lands first and would read as a user
  scroll, closing the panel the instant it opened.
- Closing is click-outside, Escape, table/window scroll, and (mouse only, behind a
  `(hover: hover)` check) 400ms after the pointer leaves — a touch device has no hover, and a stray
  `mouseleave` there would shut the panel immediately.

### Guards are shared and defense-in-depth

`src/guards.js` exports one `screenReason(cand)` used by **both** sourcing and **every** send
(including follow-ups). Rule order matters — first match wins and becomes the reject reason string
surfaced in the dashboard/Audit page. Categories: China policy, flagged notes, junk email,
non-developer business names, brand impersonation, official companies/governments, competitor
publishers (ZipoApps accounts), top-app sanity.

### Email

`src/email.js` uses the **Gmail API over HTTPS** via `googleapis`, with an OAuth refresh token stored
in `settings`. This is deliberate: **Railway blocks outbound SMTP (both 465 and 587)** — do not
"simplify" this back to nodemailer/SMTP. The OAuth flow is `/oauth/start` → `/oauth/callback` in the
dashboard. Threading works by storing `message_id` + `thread_id` per lead so follow-ups land in the
same Gmail conversation.

### Dashboard

`src/server.js` (~800 lines) is a single-file server-rendered dashboard — no client framework, HTML
built as template strings, everything escaped through `esc()`. Basic-auth gated; `/health` is the
only unauthenticated route. Filters are GET query params so views are shareable.

## Conventions and gotchas

- **Outreach email copy must use only short hyphens (`-`).** No em/en dashes (`—`, `–`) in anything
  in `src/templates.js` that reaches a recipient. This is an explicit owner requirement.
- **`--once` in the npm scripts is a no-op.** Only `refill.js` reads a flag, and it is `--force`.
  `npm run sourcing:once` therefore stands down when the queue is above `refillFloor`; use
  `node src/jobs/refill.js --force` to actually source.
- **CSS scoping in `server.js` is deliberate.** `label{display:block}` and `input{width:100%}` are
  scoped to `.grid` on purpose; making them global again breaks every flex toolbar/filter row.
- **Tooltips (`title=`) do not work on touch devices.** Any explanation that matters must also exist
  in visible text (the dashboard has a tap-to-open glossary for this reason).
- `db.insertLead()` skips duplicates by email at the SQL level and returns `null` — callers must
  handle that (refill treats it as "merge into existing").
- Schema changes go in `db.init()` **and** its `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration
  list, since production databases already exist.
