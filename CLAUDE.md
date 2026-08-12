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
