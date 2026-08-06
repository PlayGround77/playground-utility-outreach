# Deployment Guide — PlayGround Utility Outreach (Railway)

Follow these in order. No code copy-paste — you deploy by connecting this repo.

## 1. Gmail App Password

The app sends and reads email from your mailbox (e.g. `contact@plygrndstudio.com`)
using a Google **App Password**:

1. That Google account → **Manage your Google Account → Security**.
2. Turn on **2-Step Verification** (required for app passwords).
3. **Security → App passwords** → create one (name it "Outreach"). Copy the
   16-character password (shown as `xxxx xxxx xxxx xxxx`).

## 2. Create the Railway project

1. Sign in to [railway.app](https://railway.app).
2. **New Project → Deploy from GitHub repo** → pick
   `PlayGround77/playground-utility-outreach` (branch
   `claude/publishing-outreach-system-glky2c`). Railway auto-detects Node and builds it.
3. In the project, **New → Database → Add PostgreSQL**. Railway creates
   `DATABASE_URL` and (once you reference it) injects it into the app service.
   - In the app service **Variables**, add a reference so `DATABASE_URL` points
     at the Postgres service (Railway offers this as a one-click reference).

## 3. Set the service Variables

App service → **Variables** → add (see `.env.example` for the full list):

| Variable | Value |
|---|---|
| `GMAIL_USER` | `contact@plygrndstudio.com` |
| `GMAIL_APP_PASSWORD` | the 16-char app password from step 1 (spaces ok) |
| `APPSTORESPY_KEY` | your AppStoreSpy API key |
| `DASHBOARD_PASS` | a strong password for the dashboard |
| `DRY_RUN` | `true` (keep it true for now) |
| `SUMMARY_TO` | `contact@plygrndstudio.com` |
| `RAMP_START_DATE` | the Monday you plan to go live, e.g. `2026-08-10` |

Brand defaults (PlayGround / Yogev / your phone) are already baked in; override
with `OWNER_NAME`, `OWNER_PHONE`, `PUBLISH_URL`, `CALENDAR_URL` if needed.

## 4. First boot

After it deploys, open the service **URL** (Railway → Settings → Networking →
Generate Domain). You'll get a browser login prompt — user `admin`, password =
`DASHBOARD_PASS`. The dashboard loads empty.

## 5. Prove sourcing (uses a few AppStoreSpy credits)

Two options:
- **Dashboard:** click **Source now**. Watch Railway **Deploy Logs** — you'll see
  `[refill] [DRY] add "…"` lines (nothing is written to the DB while `DRY_RUN=true`).
- **Self-test:** Railway → the service → **Settings → Deploy** shell, or locally:
  `npm run test:appstorespy` — prints one real candidate end-to-end.

## 6. Prove sending (dry)

Click **Send tick now**. Logs show `[sender] [DRY] NEW -> …` with the exact
email that *would* be sent. Nothing leaves the mailbox while `DRY_RUN=true`.

## 7. Go live (gated)

When you've reviewed a sourced list and are ready:

1. Set `DRY_RUN=false` in Railway Variables → the service redeploys.
2. The schedulers now run automatically: sourcing 07:30, sending every 15 min
   inside 09:00–18:00 Asia/Jerusalem (Mon–Fri), reply check every 30 min, daily
   summary email at 08:00.
3. Watch the first day's summary email and the dashboard counters.

To pause at any time: set `DRY_RUN=true` again (redeploys, stops all sending).

## Ongoing

- Work replies from the dashboard: **📞 Booked** / **🚫 Not rel.** set the
  Response status; **⛔ Block** moves a studio to the Block List (never contacted again).
- All code changes: edit and `git push` — Railway rebuilds automatically.
