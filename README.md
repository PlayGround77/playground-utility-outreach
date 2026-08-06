# PlayGround Utility Outreach

Automated cold-outreach pipeline for recruiting mobile **utility-app** studios
into PlayGround's publishing program. Runs as a Node.js service on **Railway**.

```
AppStoreSpy (sourcing) → Postgres (queue + CRM) → Gmail (SMTP send / IMAP read)
     ↑                                                      ↓
     └────────── auto-refill when queue < 150 ──── reply detection loop
                         ↕
                 web dashboard (view leads, work replies)
```

- Sources utility-app studios from AppStoreSpy (games excluded) in an installs band
- Screens them through a layered rejection firewall (`src/guards.js`)
- Emails a personalized 3-touch sequence (initial → FU1 → FU2 → close) in one Gmail thread
- Detects replies/bounces over IMAP, updates the record, stops sequences
- Refills its own queue when it runs low
- A password-protected dashboard shows the pipeline and lets you set statuses
- Everything updates by `git push` — no copy-paste into any editor

## Deploy (Railway)

See **[SETUP.md](SETUP.md)** for the full walkthrough. In short:

1. Create a Google **App Password** for the sending mailbox (needs 2-Step Verification).
2. On Railway: **New Project → Deploy from GitHub repo** (this repo), then **add a Postgres** service.
3. Set the service **Variables** (see `.env.example`): `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
   `APPSTORESPY_KEY`, `DASHBOARD_PASS`, and keep `DRY_RUN=true`.
4. Open the dashboard (the service URL), click **Source now**, then **Send tick now** — all logged, nothing sent while `DRY_RUN=true`.
5. When you've approved going live, set `DRY_RUN=false` in Railway and redeploy.

## Layout

| Path | Role |
|---|---|
| `src/config.js` | All settings from environment variables |
| `src/guards.js` | Screening firewall (China policy, junk email, brand impersonation, top-app sanity) |
| `src/appstorespy.js` | AppStoreSpy client (query utility apps + fetch developer) |
| `src/templates.js` | Email copy + signature |
| `src/email.js` | Gmail SMTP send + IMAP reply/bounce scan |
| `src/db.js` | Postgres schema + queries (the queue + CRM) |
| `src/jobs/*` | `sender`, `replywatcher`, `refill`, `summary` |
| `src/scheduler.js` | Cron: sender/15m, watcher/30m, summary 08:00, refill 07:30 |
| `src/server.js` | Web dashboard (basic auth) |
| `scripts/test-appstorespy.js` | Sourcing self-test (`npm run test:appstorespy`) |
| `docs/SYSTEM.md` | Full conceptual reference (rules, cadence, guards) |
| `apps-script/` | Legacy Google Apps Script implementation (superseded by this Node app) |

## Safety

Dry-run default, a bounce brake, a warm-up ramp for the new mailbox, and a hard
rule: **`DRY_RUN` is only set to `false` by a deliberate Railway variable change
after explicit sign-off.** Read `docs/SYSTEM.md §10` before going live.
