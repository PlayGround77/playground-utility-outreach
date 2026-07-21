/**
 * Config.gs — Central configuration for the PlayGround Utility Outreach Engine.
 *
 * Data store: GOOGLE SHEETS (native to Apps Script — no external API/token).
 *
 * EVERYTHING that is environment-, brand-, or account-specific lives here.
 * Code.gs / Sheet.gs / PoolRefill.gs read from this object and never hard-code
 * addresses, criteria, or copy.
 *
 * SECRETS POLICY: API tokens are NEVER stored in this file. The only external
 * token is AppStoreSpy, kept in Script Properties (Project Settings > Script
 * Properties). This file only names the KEY under which it is stored.
 *
 * Placeholders are written as <<LIKE_THIS>>. The engine refuses to send live
 * email while any placeholder remains (see validateForLive_ in Code.gs), so it
 * is safe to deploy this file first and fill values in incrementally.
 */

const CONFIG = {

  // ---------------------------------------------------------------------------
  // 1. BRAND / IDENTITY  (PlayGround — no third-party publisher references)
  // ---------------------------------------------------------------------------
  brand: {
    companyName: 'PlayGround',
    ownerName:   'Yogev',
    ownerTitle:  'Publishing Manager',
    ownerEmail:  'contact@plygrndstudio.com',  // the sending mailbox
    phone:       '+44 7828592964',
    website:     'https://www.plygrndstudio.com',
    publishUrl:  '',   // optional "publish your app" landing page ('' = omit)
    calendarUrl: ''    // optional booking link ('' = omit; add later if wanted)
  },

  // ---------------------------------------------------------------------------
  // 2. SCRIPT PROPERTY KEY for the one external secret (set in Script Properties)
  // ---------------------------------------------------------------------------
  secretKeys: {
    appStoreSpy: 'APPSTORESPY_KEY'
  },

  // ---------------------------------------------------------------------------
  // 3. GOOGLE SHEET (the queue + CRM — single source of truth)
  //
  //    Two ways to bind:
  //    (a) CONTAINER-BOUND (recommended, simplest): create the script from
  //        inside the Sheet via Extensions > Apps Script. Leave spreadsheetId
  //        empty — the engine uses the active spreadsheet.
  //    (b) STANDALONE: paste the Sheet's ID (from its URL between /d/ and /edit).
  //
  //    Run SETUP_SHEET() once to create the tab + header row automatically.
  // ---------------------------------------------------------------------------
  sheet: {
    spreadsheetId: '',      // '' = use active spreadsheet (container-bound)
    tabName: 'Leads',

    // Column header names (row 1). SETUP_SHEET() writes these in this order.
    headers: {
      name:        'Studio Name',
      email:       'Email',
      outreach:    'Outreach Status',
      response:    'Response Status',
      initialDate: 'Initial Date',
      fu1Date:     'FU1 Date',
      fu2Date:     'FU2 Date',
      priority:    'Priority',
      notes:       'Notes',        // stores Gmail threadId as [thread:ID]
      storeLink:   'Store Link',
      topApp:      'Top App',
      group:       'Group'         // date group / Block List / Replied / Pool DD.MM
    },

    // Values written into the Outreach Status / Response Status cells.
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

    // Special group names (written into the Group column).
    groups: {
      blockList: 'Block List', // never contacted, never refill-added
      replied:   'Replied'     // legacy/manual, excluded from sending
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
    rampStartDate: '2026-07-27', // Monday you go live; anchors week math

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
    poolRefillHour:   7        // 07:00 (refill runs at :30)
  },

  // ---------------------------------------------------------------------------
  // 8. SAFETY
  // ---------------------------------------------------------------------------
  safety: {
    minSendsForBrake: 20,      // bounce brake activates once daily sends >= this
    bounceRatioMax:   0.05,    // ...and pauses if bounces/sends exceeds this
    refillFloor:      150,     // refill when sendable queue < this
    refillTarget:     250      // source ~this many new studios per refill
  },

  // ---------------------------------------------------------------------------
  // 9. DRY RUN — TRUE means log-only: NO emails, NO sheet writes, NO labels.
  //    Keep TRUE until the pipeline is proven end-to-end and you have given a
  //    fresh explicit approval to go live (see docs §10).
  // ---------------------------------------------------------------------------
  DRY_RUN: true
};
