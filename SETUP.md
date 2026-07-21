# Deployment Guide — PlayGround Utility Outreach

Follow these in order. Nothing here assumes prior knowledge of the system.

## 1. Mailbox

Create a dedicated Google Workspace mailbox for PlayGround outreach (e.g.
`contact@plygrndstudio.com`). It is a **new** sending identity, so the engine
uses the full warm-up ramp `30 → 50 → 75 → 100` sends/day over the first weeks
(`CONFIG.sender.ramp`).

## 2. Monday.com board

Create a board (e.g. "Utility Outreach — Agent") with these columns:

| Column | Type |
|---|---|
| Name (item) | — |
| Contact Email | Email |
| Outreach Status | Status — labels: `Email Sent`, `Follow-up 1 Sent`, `Follow-up 2 Sent`, `Sequence Closed` |
| Response Status | Status — labels: `Respond`, `Booked a call`, `Not Relevant`, `No Response` |
| Initial Email Date | Date |
| Follow-up 1 Date | Date |
| Follow-up 2 Date | Date |
| Priority Score | Numbers |
| Notes | Text |
| Store Link | Link |
| Top App | Text |

Create two static groups: **Block List** and **Replied**. (Daily `DD.MM` and
`Pool DD.MM` groups are created automatically by the engine.)

Make sure the status **labels** match `CONFIG.monday.outreachLabels` /
`responseLabels` exactly — labels are matched by text.

## 3. Apps Script project

1. Create a new Apps Script project ("Utility Outreach Engine").
2. **Services → + → Gmail API** (enables the `Gmail` advanced service used for
   raw-MIME threading).
3. Push the four `.gs` files + `appsscript.json`:
   ```bash
   cd apps-script
   cp .clasp.json.example .clasp.json      # then paste your scriptId
   clasp push
   ```

## 4. Secrets (Script Properties only)

Project Settings → Script Properties → add:

| Key | Value |
|---|---|
| `MONDAY_TOKEN` | your Monday personal API token |
| `APPSTORESPY_KEY` | your AppStoreSpy API key |

Never put these in code, chat, or committed files.

## 5. Fill Config.gs

From the Apps Script editor, run `listBoardColumns()` and `listBoardGroups()`
and read the execution log — they print every real column/group ID. Paste them
into `CONFIG.monday`. Then fill the remaining `<<PLACEHOLDERS>>`: brand details,
`boardId`, `rampStartDate` (the Monday you go live). The engine refuses to send
live while any `<<...>>` remains.

## 6. Align the AppStoreSpy mapping

`PoolRefill.gs` isolates every AppStoreSpy field name in `mapAppStoreSpyRow_()`
and `fetchTopApp_()`. Run one refill in dry mode, look at a raw row in the logs,
and adjust those two functions to your plan's actual response shape.

## 7. Dry run

With `CONFIG.DRY_RUN = true`:
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
