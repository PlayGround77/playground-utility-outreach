# PlayGround Utility Outreach

Fully automated cold-outreach pipeline for recruiting mobile **utility-app**
studios into PlayGround's publishing program.

```
AppStoreSpy (sourcing) → Google Sheet (queue + CRM) → Gmail (sending)
     ↑                                                     ↓
     └───────── auto-refill when queue < 150 ──── reply detection loop
```

- Sources utility-app studios from AppStoreSpy against defined criteria
- Screens them through a layered rejection firewall (see `apps-script/Guards.gs`)
- Emails a personalized 3-touch sequence (initial → FU1 → FU2 → close), all in one Gmail thread
- Detects replies/bounces automatically, updates the sheet, stops sequences
- Refills its own queue when it runs low
- Reports daily by email
- The human's only jobs: answer replies, approve lists, watch daily summaries

Everything runs inside **Google Apps Script** on your own Google account. The
only external service that needs a token is AppStoreSpy — Gmail and Google
Sheets are native, so there is nothing extra to "connect".

## Layout

| File | Role |
|---|---|
| `apps-script/Config.gs` | All brand, sheet, criteria, and schedule settings (fill placeholders) |
| `apps-script/Guards.gs` | Shared screening firewall (China policy, junk email, brand impersonation, top-app sanity) |
| `apps-script/Sheet.gs` | Google Sheets data layer (read/update/append rows) |
| `apps-script/Code.gs` | Sending engine, follow-up cadence, reply watcher, daily summary, setup |
| `apps-script/PoolRefill.gs` | AppStoreSpy sourcing with chunked chaining + whole-sheet dedup |
| `apps-script/appsscript.json` | Manifest (Gmail Advanced Service, Sheets scope, timezone) |
| `docs/SYSTEM.md` | Full technical & operational reference |
| `SETUP.md` | Step-by-step deployment guide |

## Quick start

1. Create a dedicated Gmail mailbox for PlayGround outreach and a Google Sheet.
2. Create the Apps Script project (ideally from **Extensions → Apps Script**
   inside the Sheet so it binds automatically) and paste these files.
3. Enable the Gmail Advanced Service; put `APPSTORESPY_KEY` in **Script Properties**.
4. Run `SETUP_SHEET()` to build the sheet's header row.
5. Fill every `<<PLACEHOLDER>>` in `Config.gs` (brand details + `rampStartDate`).
6. Keep `CONFIG.DRY_RUN = true`, run `runSender()` once, and read the logs.
7. Only after a clean dry run **and** explicit sign-off, flip `DRY_RUN` to `false`.

Full instructions: [`SETUP.md`](SETUP.md).

## Safety

Dry-run default, a bounce brake, a warm-up ramp for new mailboxes, a config
placeholder guard that blocks live sends while any `<<...>>` remains, and a hard
approval rule: **the `DRY_RUN` flag is never flipped to `false` without a fresh,
explicit approval.** Read `docs/SYSTEM.md §10` before going live.
