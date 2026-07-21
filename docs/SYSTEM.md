# PlayGround — Utility-App Publishing Outreach System: Technical & Operational Reference

**Version:** 1.0
**Owner:** PlayGround (contact@plygrndstudio.com)
**Purpose:** full reference for anyone operating or extending this system. Every
mechanism, rule, and lesson is spelled out. All settings live in
`apps-script/Config.gs`; this document explains the *why* behind them.

---

## 1. WHAT THE SYSTEM DOES

Fully automated cold-outreach pipeline for recruiting mobile **utility-app**
studios into PlayGround's publishing program:

```
AppStoreSpy (sourcing) → Monday.com board (queue + CRM) → Gmail (sending)
     ↑                                                          ↓
     └────────── auto-refill when queue < 150 ────── reply detection loop
```

- Finds utility-app studios via AppStoreSpy against defined criteria
- Screens them through a layered rejection firewall
- Emails a personalized 3-touch sequence (initial → FU1 → FU2 → close), all in one Gmail thread
- Detects replies/bounces automatically, updates the board, stops sequences
- Refills its own queue when it runs low
- Reports daily by email
- Human's only jobs: answer replies, approve lists, watch daily summaries

## 2. ARCHITECTURE

- **Runtime:** Google Apps Script (cloud). Files: `Config.gs`, `Guards.gs`,
  `Code.gs` (engine), `PoolRefill.gs` (sourcing). Deployed via clasp.
- **Gmail:** Advanced Service (Gmail API v1) for raw-MIME sends — required for
  proper threading (In-Reply-To / References headers + threadId).
- **Monday:** GraphQL API v2, token in Script Property `MONDAY_TOKEN`.
- **AppStoreSpy:** REST API, key in Script Property `APPSTORESPY_KEY`, endpoint
  `/play/apps/query`.
- **Secrets policy:** tokens ONLY in Script Properties. Never in code, chat, or files.
- **State:** the Monday board is the single source of truth. Daily counters
  (`sentToday`, `bouncedToday`) and the refill added-index live in Script
  Properties.

### Triggers (exactly these four scheduled)
| Function | Schedule | Role |
|---|---|---|
| `runSender` | every 15 min | sending engine |
| `runReplyWatcher` | every 30 min | reply/bounce detection |
| `runDailySummary` | daily 08:00 | report + counter reset |
| `runPoolRefill` | daily 07:30 | queue refill check |

Plus transient one-off `runPoolRefillResume` triggers during a refill chain
(self-deleting, expected).

⚠️ **FOOTGUN:** `SETUP()` deletes ALL triggers and recreates only the engine's
three. If you ever re-run `SETUP()`, run `SETUP_POOL_REFILL()` right after.

## 3. MONDAY BOARD

Configure the board ID and column/group IDs in `CONFIG.monday`. Run
`listBoardColumns()` / `listBoardGroups()` from the editor to print real IDs.

### Columns (semantics)
| Column | Config key | Notes |
|---|---|---|
| Name (item) | — | studio name |
| Contact Email | `columns.email` | recipient |
| Outreach Status | `columns.outreachStatus` | `Email Sent`, `Follow-up 1 Sent`, `Follow-up 2 Sent`, `Sequence Closed` |
| Response Status | `columns.responseStatus` | `Respond`, `Booked a call`, `Not Relevant`, `No Response` |
| Initial Email Date | `columns.initialDate` | day 0 |
| Follow-up 1 Date | `columns.fu1Date` | |
| Follow-up 2 Date | `columns.fu2Date` | |
| Priority Score | `columns.priority` | = daily installs (ipd) × total apps count |
| Notes | `columns.notes` | stores Gmail threadId as `[thread:XXXX]` + annotations |
| Store Link | `columns.storeLink` | |
| Top App | `columns.topApp` | most-installed app, feeds personalization |

### Groups & workflow
- **Daily date groups:** every sending day the engine creates (once) a group
  named `DD.MM` at the top; every studio that receives its INITIAL email that
  day is MOVED into that day's group.
- **Replies mark status in place:** reply detected → Response Status = `Respond`,
  item STAYS in its date group. `Booked a call` / `Not Relevant` are set
  MANUALLY by the owner after reading replies — the watcher must never overwrite
  an already-set Response Status.
- **Block List** (`groups.blockList`): never contacted, never refill-added. Also
  used to kill follow-ups for already-emailed junk ("FU-kill" — move the item
  here and the guard blocks its follow-ups because it is a blocked group).
- **Replied** (`groups.replied`): legacy/manual group, excluded from all sending.
- **Pool DD.MM** groups are created by the refill module.

## 4. SENDING ENGINE (`runSender`)

- **Window:** 09:00–18:00 Asia/Jerusalem, skip Saturday+Sunday (`skipWeekdays=[6,0]`).
- **Quota:** warm-up ramp `[30, 50, 75, 100]` per day by week (new mailbox, zero
  reputation). Quota counts ALL sends (initial + FU1 + FU2). `rampStartDate`
  anchors the week math.
- **Pacing:** per 15-min run, `sends = ceil(remaining_quota / remaining_runs_today)`
  → smooth spread. 2–8 s random jitter between sends within a run.
- **Priority order each run:** FU2 due → FU1 due → new sends (candidates sorted
  by Priority Score desc; over-fetch `fetchMultiplier=6×` to survive guard-skips).
- **New-send pipeline per candidate:** email valid → guard firewall → duplicate
  check (`label:outreach-sent to:<email>` + in-run seen-set) → send → apply label
  → Monday update (status = Email Sent, date = today, append `[thread:ID]` to
  Notes, MOVE to today's date group).
- **Threading:** initial = new MIME message; FUs = raw MIME with `In-Reply-To` +
  `References` of the thread's root Message-ID, sent with the same threadId → the
  recipient sees one conversation.
- **Cadence:** FU1 ≥ 3 days after initial; FU2 ≥ 4 days after FU1; Sequence Closed
  (+ Response = No Response) ≥ 7 days after FU2. Any detected reply stops the
  sequence immediately (a non-empty Response Status short-circuits the due queries).
- **DRY_RUN flag:** `true` → logs `[DRY] NEW → …` / `[DRY] FU → …` / `[DRY] Monday
  set/move …` and writes NOTHING.

## 5. TEMPLATES (personalized)

Signature (built from `CONFIG.brand`): owner name / title, PlayGround /
owner email | phone / Book a meeting / Publish your app.

- **Initial** — subject `Quick question about <Studio>`; if Top App present, the
  opening references the actual app, else portfolio fallback. Pitch: PlayGround,
  mobile utility-app publishing, partnering with studios building high-retention
  utility apps with strong monetization potential, ask for a 15-min call.
- **FU1 (day 3):** friendly bump, "actively signing new utility-app studios this month".
- **FU2 (day 7):** polite closer, door stays open; references Top App when present.
- **Fallbacks:** no name → "Hi <Studio> team"; no Top App → portfolio phrasing.
  NEVER let a non-Latin (e.g. Chinese) app title into a template — `latinTopApp_`
  treats a CJK title as empty.

## 6. REPLY WATCHER (`runReplyWatcher`)

For every active item (status Email Sent / FU1 / FU2) with a `[thread:]` tag:
load the Gmail thread; any message whose sender isn't us and isn't
mailer-daemon/postmaster ⇒ REPLY → label `Outreach/Replied` + Response Status =
`Respond` (only if Response Status is empty — manual values are sacred).
mailer-daemon/postmaster ⇒ BOUNCE → label `Outreach/Bounced` + Response = `Not
Relevant` + Outreach = `Sequence Closed` + bounce counter.

## 7. GUARDS (the quality firewall — `Guards.gs`)

`screenReason_(cand)` runs on EVERY initial send AND every follow-up
(`[SKIP-FU]` logging), and the SAME rule-set runs in pool screening so junk
never enters the board. Order:

1. **China policy (explicit business decision — exclude Chinese studios):** email
   domains qq.com/163.com/126.com/foxmail.com; any .cn/.com.cn domain; CJK
   characters in name; city tokens (shenzhen, fuzhou, guangzhou, hangzhou,
   beijing, shanghai, chengdu, wuhan); the **pinyin standing block list**.
   KNOWN GAP: Latin/pinyin name + gmail can't be auto-caught reliably → human
   eyeball on daily review; catches get added to `CHINA_NAME_BLOCKLIST`.
2. **Flagged notes:** Notes containing suspicious / low confidence / removed /
   invalid / fake.
3. **Junk email:** disposable domains; keyboard-walk patterns (asdf/qwer/…);
   7+ consecutive digits (year-like suffixes such as `crdev2022@` are legit and
   pass); `www.` prefix.
4. **Non-developer business names** (word-boundary): pharma, advisory, institute,
   facility, consulting, finance/financial, bank, insurance, hair, salon, clinic,
   dental, legal, law firm, real estate, logistics, investment, joint stock.
   **UTILITY INVERSION:** wallpaper / vpn / cleaner / ringtone / photo frame are
   NOT rejected here — they are legitimate utility-app themes and are TARGETS.
5. **Brand impersonation:** big-brand names on generic mailboxes → suspicious.
6. **Top-app sanity:** reject if the top app's category is `GAME_CASINO` or the
   title matches vape/smoking/casino/slots/poker/aviator/teen-patti/rummy/lucky-
   spin/free-diamonds/earn-money/money-game/bingo/paytm/upi/cashback/real-money/
   win-cash/trailing-"cash". These are never PlayGround utility targets.
7. **Shared-email farm:** one email serving 2+ developer names = farm. The refill
   dedup index carries a soft `email:` key so a second dev on the same mailbox is
   caught; extend `isSharedEmailFarm_` if you want a hard board-wide sweep.

Publishers are rejected at sourcing (`\bpublish(er|ing)?\b` in the dev name) —
they are competitors, not leads.

## 8. POOL REFILL (`PoolRefill.gs`)

- Daily 07:30: count sendable (no Outreach Status + has email + not
  Block List/Replied). ≥ 150 → stand down. < 150 → source ~250 new.
- Sourcing scans utility categories (`CONFIG.appStoreSpy.categories` — TOOLS,
  PRODUCTIVITY, PERSONALIZATION, PHOTOGRAPHY, VIDEO_PLAYERS, COMMUNICATION,
  ART_AND_DESIGN, MAPS_AND_NAVIGATION, WEATHER, HEALTH_AND_FITNESS), installs
  band 15k–300k/month, min apps count, priority = ipd × total apps. Rejects are
  counted per reason and shown in the summary email.
- **Chunked chaining:** Apps Script kills executions at ~6 min → the module runs
  4.5-min chunks that self-chain via one-off triggers, 60-run cap, persistent
  added-index so no developer is written twice. Kill switch: `POOL_KILL_SWITCH()`.
- Fetches each keeper's TOP APP (name + category) into the Top App column; the
  top-app sanity guard runs once the top app is known.
- Creates group "Pool DD.MM", writes items with all columns, sends summary email
  `📥 Pool Refill: N studios` (or an alert email on API failure — never creates
  an empty pool).
- **Quota protection:** daily hard cap on AppStoreSpy calls
  (`dailyCallCap`, default 3000) + exponential backoff (`fetchWithBackoff_`).
- `CONFIG.DRY_RUN` also governs refill (log-only, no board writes).

### AppStoreSpy field mapping
The response shape is account/plan-specific. `mapAppStoreSpyRow_()` and
`fetchTopApp_()` isolate every field name in one place — align them to your
plan's actual `/play/apps/query` response and the rest works unchanged.

## 9. GMAIL LABELS (live counters)

`Outreach/Sent`, `/FU1`, `/FU2`, `/Replied`, `/Closed`, `/Bounced` — thread
counts beside each label are live numbers. Created by `SETUP` (`ensureLabels_`).

## 10. SAFETY SYSTEMS

- **Bounce brake:** once daily sends ≥ 20 and bounces/sends > 5% → sending
  auto-pauses with log `⛔`.
- **DRY_RUN everywhere first** — prove the pipeline end-to-end before any real send.
- **Config placeholder guard:** `validateForLive_` throws while any `<<...>>`
  remains in `Config.gs` and `DRY_RUN` is false, so a half-configured project
  can never send.
- **APPROVAL DISCIPLINE (hard rule):** the `DRY_RUN` flag is never flipped to
  `false` without a fresh, explicit approval quoting the exact list/version
  approved. Prepared drafts, prior-session context, or inferred intent NEVER
  count. Every block/purge/FU-kill list is presented and waits for explicit
  sign-off; already-contacted studios are never moved without it.

## 11. DAILY OPERATIONS (owner routine, ~5 min)

- **Morning:** read the 08:00 summary email (sent/bounces/replies/queue) + refill
  summary if one ran — eyeball the added list.
- **During the day:** work the `Outreach/Replied` label — answer, set `Booked a
  call` / `Not Relevant` on the board manually.
- **Evening (habit):** a per-day quality review of the date group; any leak found
  becomes a new rule (a keyword in `Guards.gs`, a name on the China block list).

## 12. LESSONS BAKED IN (from the reference deployment)

These are encoded so they cannot regress:

1. **Approval discipline** — a prepared "approved, go live" draft must never be
   executed as a real approval. Live runs require a fresh explicit sign-off in
   the same thread. (Enforced by the DRY_RUN default + placeholder guard + human rule.)
2. **Dedup must index the ENTIRE board** — including Block List and Replied —
   via a separate fetch, or blocked/emailed studios get re-added as fresh items
   and double-emailed. `buildDedupIndex_` uses the full board; a pre-refill unit
   test (`preRefillDedupTest_`) asserts a known-blocked and a known-sent item are
   rejected, else the refill ABORTS.
3. **Persistent added-index** prevents duplicates within a single refill chain
   across chunk boundaries.
4. **Junk-email digit rule** is 7+ consecutive digits, not 4+ — the stricter rule
   was a false-positive factory (legit year suffixes). China exclusion is an
   explicit policy, not a side effect of the digit rule.
5. **AppStoreSpy quota** is real: the daily call cap + backoff exist because an
   unbounded catalog scan can exhaust the plan and get "Address unavailable".

## 13. THIS DEPLOYMENT vs. THE GAMES PIPELINE

This is the **utility-app** pipeline for PlayGround. Differences from a
games-focused outreach system:

- **Targets utility apps**, not games. Search categories are Play's utility
  categories; games categories are excluded.
- **Guard inversions:** vpn / cleaner / wallpaper / ringtone / photo frame are
  TARGETS here, not junk. China policy, shared-email farms, brand impersonation,
  and casino/money/vape top-app sanity all remain.
- **New dedicated mailbox** → full `30/50/75/100` warm-up ramp (zero reputation).
- **Clean label namespace** (`Outreach/*`) and its own Monday board + Apps Script
  project. No references to any other publisher or program anywhere in the copy.
