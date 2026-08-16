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
- **`enrichFromSite` is opt-in** (criteria flag, like `scanReviews`) and wrapped in `try/catch` in
  `refill.js` — enrichment failing must never break a sourcing run. It has its own daily fetch cap,
  8s timeout, 1MB body cap, redirect cap and robots.txt check, because unlike AppStoreSpy these are
  arbitrary third-party servers.
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
