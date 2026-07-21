/**
 * Config.gs — Central configuration for the PlayGround Utility Outreach Engine.
 *
 * EVERYTHING that is environment-, brand-, or account-specific lives here.
 * Code.gs and PoolRefill.gs read from this object and never hard-code IDs,
 * addresses, or copy.
 *
 * SECRETS POLICY: API tokens are NEVER stored in this file. They live only in
 * Script Properties (File > Project properties > Script properties, or via the
 * Apps Script UI). This file only names the KEYS under which they are stored.
 *
 * Placeholders are written as <<LIKE_THIS>>. The engine refuses to send live
 * email while any placeholder remains (see validateConfig_ in Code.gs), so it
 * is safe to deploy this file first and fill values in incrementally.
 */

const CONFIG = {

  // ---------------------------------------------------------------------------
  // 1. BRAND / IDENTITY  (PlayGround — no third-party publisher references)
  // ---------------------------------------------------------------------------
  brand: {
    companyName: 'PlayGround',
    ownerName:   '<<OWNER_FULL_NAME>>',        // e.g. "Dana Levi"
    ownerTitle:  'Publishing Manager',
    ownerEmail:  'contact@plygrndstudio.com',  // the sending mailbox
    phone:       '<<OWNER_PHONE>>',            // e.g. "+44 7000 000000"
    website:     'https://www.plygrndstudio.com',
    publishUrl:  '<<PUBLISH_YOUR_APP_URL>>',   // your "publish your app" landing page
    calendarUrl: '<<BOOK_A_MEETING_URL>>'      // your booking link
  },

  // ---------------------------------------------------------------------------
  // 2. SCRIPT PROPERTY KEYS for secrets (values set in Script Properties only)
  // ---------------------------------------------------------------------------
  secretKeys: {
    monday:      'MONDAY_TOKEN',
    appStoreSpy: 'APPSTORESPY_KEY'
  },

  // ---------------------------------------------------------------------------
  // 3. MONDAY.COM BOARD
  //    Create a fresh board for PlayGround, then run listBoardColumns() and
  //    listBoardGroups() (in Code.gs) from the Apps Script editor to print the
  //    real IDs, and paste them here.
  // ---------------------------------------------------------------------------
  monday: {
    apiUrl:     'https://api.monday.com/v2',
    apiVersion: '2024-10',
    boardId:    '<<BOARD_ID>>',

    // Column IDs — semantics mirror the reference system; IDs are per-board.
    columns: {
      email:          '<<COL_EMAIL>>',          // Contact Email (email column)
      outreachStatus: '<<COL_OUTREACH_STATUS>>',// Outreach Status (status/color)
      responseStatus: '<<COL_RESPONSE_STATUS>>',// Response Status (status/color)
      initialDate:    '<<COL_INITIAL_DATE>>',   // Initial Email Date (date)
      fu1Date:        '<<COL_FU1_DATE>>',        // Follow-up 1 Date (date)
      fu2Date:        '<<COL_FU2_DATE>>',        // Follow-up 2 Date (date)
      priority:       '<<COL_PRIORITY>>',        // Priority Score (numeric)
      notes:          '<<COL_NOTES>>',           // Notes (text) — stores [thread:ID]
      storeLink:      '<<COL_STORE_LINK>>',      // Store Link (link)
      topApp:         '<<COL_TOP_APP>>'          // Top App (text) — most-installed app
    },

    // Status labels exactly as configured on the board's status columns.
    outreachLabels: {
      emailSent:      'Email Sent',
      fu1Sent:        'Follow-up 1 Sent',
      fu2Sent:        'Follow-up 2 Sent',
      sequenceClosed: 'Sequence Closed'
    },
    responseLabels: {
      respond:     'Respond',
      bookedCall:  'Booked a call',
      notRelevant: 'Not Relevant',
      noResponse:  'No Response'
    },

    // Static group IDs (fill after board creation).
    groups: {
      blockList: '<<GROUP_BLOCK_LIST>>', // never contacted, never refill-added
      replied:   '<<GROUP_REPLIED>>'     // legacy/manual, excluded from sending
    }
  },

  // ---------------------------------------------------------------------------
  // 4. APPSTORESPY SOURCING (utility-app catalog, NOT games)
  // ---------------------------------------------------------------------------
  appStoreSpy: {
    apiUrl:   'https://api.appstorespy.com/v1',
    endpoint: '/play/apps/query',

    // Google Play UTILITY categories to scan (games deliberately excluded).
    categories: [
      'TOOLS',
      'PRODUCTIVITY',
      'PERSONALIZATION',
      'PHOTOGRAPHY',
      'VIDEO_PLAYERS',
      'COMMUNICATION',
      'ART_AND_DESIGN',
      'MAPS_AND_NAVIGATION',
      'WEATHER',
      'HEALTH_AND_FITNESS'
    ],

    installsBand: { minPerMonth: 15000, maxPerMonth: 300000 },
    minAppsCount: 2,          // studio must publish at least this many apps
    revenueMaxPerMonth: 50000,// reject studios above this (too big to publish)
    pagesPerCategory: 5,      // catalog depth per category (UrlFetch quota guard)

    // Quota protection (see §8 of docs — learned the hard way).
    dailyCallCap: 3000,       // hard cap on AppStoreSpy calls per day
    backoffBaseMs: 1000       // exponential backoff base on transient errors
  },

  // ---------------------------------------------------------------------------
  // 5. SENDING ENGINE
  // ---------------------------------------------------------------------------
  sender: {
    timezone:      'Asia/Jerusalem',
    windowStartHour: 9,        // 09:00
    windowEndHour:   18,       // 18:00
    skipWeekdays:  [6, 0],     // 6 = Saturday, 0 = Sunday (JS getDay)

    // NEW mailbox → full warm-up ramp (zero reputation). Week index into RAMP.
    ramp: [30, 50, 75, 100],
    rampStartDate: '<<YYYY-MM-DD>>', // Monday you go live; anchors week math

    fetchMultiplier: 6,        // over-fetch candidates to survive guard-skips
    jitterMinSec: 2,
    jitterMaxSec: 8,

    // Cadence (days).
    fu1AfterDays: 3,           // FU1 >= 3 days after initial
    fu2AfterDays: 4,           // FU2 >= 4 days after FU1
    closeAfterDays: 7          // close >= 7 days after FU2
  },

  // ---------------------------------------------------------------------------
  // 6. GMAIL LABELS (clean PlayGround namespace)
  // ---------------------------------------------------------------------------
  labels: {
    root:    'Outreach',
    sent:    'Outreach/Sent',
    fu1:     'Outreach/FU1',
    fu2:     'Outreach/FU2',
    replied: 'Outreach/Replied',
    closed:  'Outreach/Closed',
    bounced: 'Outreach/Bounced'
  },

  // ---------------------------------------------------------------------------
  // 7. REPORTING
  // ---------------------------------------------------------------------------
  report: {
    summaryTo:      'contact@plygrndstudio.com',
    dailySummaryHour: 8,       // 08:00
    poolRefillHour:   7        // 07:00
  },

  // ---------------------------------------------------------------------------
  // 8. SAFETY
  // ---------------------------------------------------------------------------
  safety: {
    // Bounce brake: once daily sends >= minSendsForBrake, pause if the bounce
    // ratio exceeds bounceRatioMax.
    minSendsForBrake: 20,
    bounceRatioMax:   0.05,
    refillFloor:      150,     // refill when sendable queue < this
    refillTarget:     250      // source ~this many new studios per refill
  },

  // ---------------------------------------------------------------------------
  // 9. DRY RUN — TRUE means log-only: NO emails, NO board writes, NO labels.
  //    Keep TRUE until you have proven the pipeline end-to-end and the owner
  //    has given fresh explicit approval to go live (see docs §10).
  // ---------------------------------------------------------------------------
  DRY_RUN: true
};
