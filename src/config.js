'use strict';

/**
 * Central configuration, driven entirely by environment variables (set in the
 * Railway dashboard). Secrets NEVER live in code — only their env var names do.
 *
 * Required env vars:
 *   DATABASE_URL          (Railway Postgres provides this automatically)
 *   GMAIL_USER            the sending mailbox, e.g. contact@plygrndstudio.com
 *   GMAIL_APP_PASSWORD    a Google App Password for that mailbox
 *   APPSTORESPY_KEY       AppStoreSpy API key
 *   DASHBOARD_PASS        password for the web dashboard (basic auth)
 *
 * Optional (sensible defaults): OWNER_NAME, OWNER_PHONE, COMPANY_NAME, WEBSITE,
 *   PUBLISH_URL, CALENDAR_URL, SUMMARY_TO, RAMP, RAMP_START_DATE, INSTALLS_MIN,
 *   INSTALLS_MAX, MIN_APPS, REVENUE_MAX, CATEGORIES, REFILL_FLOOR, REFILL_TARGET,
 *   TIMEZONE, DRY_RUN, DASHBOARD_USER, PORT.
 */

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true';
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function list(v, dflt) {
  if (!v) return dflt;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  brand: {
    companyName: process.env.COMPANY_NAME || 'PlayGround',
    ownerName: process.env.OWNER_NAME || 'Yogev',
    ownerTitle: process.env.OWNER_TITLE || 'Publishing Manager',
    // The legal entity, used where the email is about a transaction rather than
    // a first hello (diligence requests, NDA offers).
    legalName: process.env.LEGAL_NAME || 'Playground Studio LLC',
    ownerEmail: process.env.GMAIL_USER || '',
    phone: process.env.OWNER_PHONE || '',
    website: process.env.WEBSITE || 'https://www.plygrndstudio.com',
    publishUrl: process.env.PUBLISH_URL || '',
    calendarUrl: process.env.CALENDAR_URL || ''
  },

  gmail: {
    user: process.env.GMAIL_USER || ''  // the sending mailbox / From address
  },

  // Gmail API over HTTPS (port 443 — never blocked, unlike SMTP). The refresh
  // token is obtained via the in-app "Connect Gmail" OAuth flow and stored in DB.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || ''
  },

  databaseUrl: process.env.DATABASE_URL || '',

  appStoreSpy: {
    key: process.env.APPSTORESPY_KEY || '',
    apiUrl: 'https://api.appstorespy.com/v1',
    endpoint: '/play/apps/query',
    categories: list(process.env.CATEGORIES, [
      'TOOLS', 'PRODUCTIVITY', 'PERSONALIZATION', 'PHOTOGRAPHY', 'VIDEO_PLAYERS',
      'COMMUNICATION', 'ART_AND_DESIGN', 'MAPS_AND_NAVIGATION', 'WEATHER', 'HEALTH_AND_FITNESS'
    ]),
    installsBand: {
      minPerMonth: num(process.env.INSTALLS_MIN, 15000),
      maxPerMonth: num(process.env.INSTALLS_MAX, 300000)
    },
    minAppsCount: num(process.env.MIN_APPS, 2),
    revenueMaxPerMonth: num(process.env.REVENUE_MAX, 50000),
    pagesPerCategory: num(process.env.PAGES_PER_CATEGORY, 5),
    dailyCallCap: num(process.env.DAILY_CALL_CAP, 3000),
    backoffBaseMs: 1000
  },

  sender: {
    timezone: process.env.TIMEZONE || 'Asia/Jerusalem',
    windowStartHour: num(process.env.WINDOW_START_HOUR, 9),
    windowEndHour: num(process.env.WINDOW_END_HOUR, 18),
    skipWeekdays: [6, 0], // Sat, Sun (JS getDay)
    ramp: list(process.env.RAMP, ['30', '50', '75', '100']).map(Number),
    rampStartDate: process.env.RAMP_START_DATE || '2026-07-27',
    fu1AfterDays: num(process.env.FU1_AFTER_DAYS, 3),
    fu2AfterDays: num(process.env.FU2_AFTER_DAYS, 4),
    closeAfterDays: num(process.env.CLOSE_AFTER_DAYS, 7),
    jitterMinSec: 2,
    jitterMaxSec: 8,
    perRunCap: num(process.env.PER_RUN_CAP, 8) // max sends per 15-min tick
  },

  report: {
    summaryTo: process.env.SUMMARY_TO || process.env.GMAIL_USER || ''
  },

  safety: {
    minSendsForBrake: num(process.env.MIN_SENDS_FOR_BRAKE, 20),
    bounceRatioMax: num(process.env.BOUNCE_RATIO_MAX, 0.05),
    refillFloor: num(process.env.REFILL_FLOOR, 150),
    refillTarget: num(process.env.REFILL_TARGET, 250)
  },

  groups: { blockList: 'Block List', replied: 'Replied' },
  statuses: {
    emailSent: 'Email Sent', fu1Sent: 'Follow-up 1 Sent',
    fu2Sent: 'Follow-up 2 Sent', sequenceClosed: 'Sequence Closed'
  },
  responses: {
    respond: 'Respond', bookedCall: 'Booked a call',
    notRelevant: 'Not Relevant', noResponse: 'No Response'
  },

  dashboard: {
    user: process.env.DASHBOARD_USER || 'admin',
    pass: process.env.DASHBOARD_PASS || ''
  },

  DRY_RUN: bool(process.env.DRY_RUN, true),
  port: num(process.env.PORT, 3000)
};

module.exports = config;
