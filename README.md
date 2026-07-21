# PlayGround Utility Outreach

Fully automated cold-outreach pipeline for recruiting mobile **utility-app**
studios into PlayGround's publishing program.

```
AppStoreSpy (sourcing) → Monday.com board (queue + CRM) → Gmail (sending)
     ↑                                                          ↓
     └────────── auto-refill when queue < 150 ────── reply detection loop
```

- Sources utility-app studios from AppStoreSpy against defined criteria
- Screens them through a layered rejection firewall (see `apps-script/Guards.gs`)
- Emails a personalized 3-touch sequence (initial → FU1 → FU2 → close), all in one Gmail thread
- Detects replies/bounces automatically, updates the board, stops sequences
- Refills its own queue when it runs low
- Reports daily by email
- The human's only jobs: answer replies, approve lists, watch daily summaries

## Layout

| File | Role |
|---|---|
| `apps-script/Config.gs` | All brand, board, criteria, and schedule settings (fill placeholders) |
| `apps-script/Guards.gs` | Shared screening firewall (China policy, junk email, brand impersonation, top-app sanity) |
| `apps-script/Code.gs` | Sending engine, follow-up cadence, reply watcher, daily summary, setup |
| `apps-script/PoolRefill.gs` | AppStoreSpy sourcing with chunked chaining + whole-board dedup |
| `apps-script/appsscript.json` | Manifest (Gmail Advanced Service, timezone, scopes) |
| `docs/SYSTEM.md` | Full technical & operational reference |
| `SETUP.md` | Step-by-step deployment guide |

## Quick start

1. Create a dedicated Gmail mailbox for PlayGround outreach.
2. Create a Monday.com board with the columns listed in `docs/SYSTEM.md §3`.
3. Create a Google Apps Script project, enable the Gmail Advanced Service, and
   push these files (`clasp push`).
4. Put `MONDAY_TOKEN` and `APPSTORESPY_KEY` in **Script Properties** (never in code).
5. Fill every `<<PLACEHOLDER>>` in `Config.gs` (use `listBoardColumns()` /
   `listBoardGroups()` to print the real IDs).
6. Keep `CONFIG.DRY_RUN = true`, run `runSender()` once, and read the logs.
7. Only after a clean dry run **and** explicit sign-off, flip `DRY_RUN` to `false`.

Full instructions: [`SETUP.md`](SETUP.md).

## Safety

This system sends real cold email under your domain's reputation. It ships with
a dry-run default, a bounce brake, a warm-up ramp for new mailboxes, and a hard
approval rule: **the `DRY_RUN` flag is never flipped to `false` without a fresh,
explicit approval.** Read `docs/SYSTEM.md §10` before going live.
