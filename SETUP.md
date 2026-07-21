# Deployment Guide — PlayGround Utility Outreach

Follow these in order. Nothing here assumes prior knowledge of the system.
Data lives in a **Google Sheet**; the engine runs in **Google Apps Script**.

## 1. Mailbox

Use a dedicated Google Workspace mailbox for PlayGround outreach (e.g.
`contact@plygrndstudio.com`). It is a **new** sending identity, so the engine
uses the full warm-up ramp `30 → 50 → 75 → 100` sends/day over the first weeks
(`CONFIG.sender.ramp`). **Log into this Google account** for everything below —
the engine sends from whichever account owns the script.

## 2. Google Sheet + Apps Script project

Recommended (simplest, no IDs to copy):

1. Create a new Google Sheet (name it e.g. "Utility Outreach").
2. In that Sheet: **Extensions → Apps Script**. This opens a project already
   bound to the Sheet (so `CONFIG.sheet.spreadsheetId` can stay empty).
3. Create the code files and paste the repo contents into each:
   `Config`, `Guards`, `Sheet`, `Code`, `PoolRefill`, and edit the manifest
   (`appsscript.json`) to match the repo's.
4. **Services → + → Gmail API** (enables the `Gmail` advanced service used for
   raw-MIME threading).

(Standalone alternative: create the project at script.google.com and paste the
Sheet's ID — from its URL between `/d/` and `/edit` — into
`CONFIG.sheet.spreadsheetId`.)

## 3. Secret (Script Properties only)

Project Settings → Script Properties → add:

| Key | Value |
|---|---|
| `APPSTORESPY_KEY` | your AppStoreSpy API key |

Never put this in code, chat, or committed files. (No Monday token needed —
the sheet is native.)

## 4. Build the sheet

From the Apps Script editor, run **`SETUP_SHEET()`** once. It creates the
`Leads` tab with the correct header row (Studio Name, Email, Outreach Status,
Response Status, Initial Date, FU1 Date, FU2 Date, Priority, Notes, Store Link,
Top App, Group) and freezes the header. Grant the permissions it requests.

Two special values you'll type into the **Group** column by hand when needed:
`Block List` (never contacted) and `Replied` (excluded from sending). Date
groups (`DD.MM`) and `Pool DD.MM` are filled automatically.

## 5. Fill Config.gs

Fill the remaining `<<PLACEHOLDERS>>`: brand details (owner name, phone,
publish URL, calendar URL) and `rampStartDate` (the Monday you go live). The
engine refuses to send live while any `<<...>>` remains.

## 6. Align the AppStoreSpy mapping

`PoolRefill.gs` isolates every AppStoreSpy field name in `mapAppStoreSpyRow_()`
and `fetchTopApp_()`. Run one refill in dry mode, look at a raw row in the logs,
and adjust those two functions to your plan's actual response shape.

## 7. Dry run

With `CONFIG.DRY_RUN = true`:
- Add a couple of test rows to the sheet (name + email + a Priority number).
- Run `runSender()` — logs `[DRY] NEW → …`, writes nothing.
- Run `runReplyWatcher()` and `runPoolRefill()` similarly.

Confirm the candidate selection, screening, and templates look right.

## 8. Install triggers

Run `SETUP()` (installs sender/15m, reply watcher/30m, daily summary/08:00 and
creates Gmail labels). Then **immediately** run `SETUP_POOL_REFILL()` — `SETUP()`
deletes all triggers, so the refill trigger must be re-added after it.

## 9. Go live (gated)

Flip `CONFIG.DRY_RUN = false` **only** after a clean dry run and a fresh,
explicit approval. Watch the first day's 08:00 summary and the Gmail label
counters (`Outreach/Sent`, `/FU1`, `/Replied`, `/Bounced`).
