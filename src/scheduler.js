'use strict';

const cron = require('node-cron');
const config = require('./config');
const { runSender } = require('./jobs/sender');
const { runReplyWatcher } = require('./jobs/replywatcher');
const { runPoolRefill } = require('./jobs/refill');
const { runDailySummary } = require('./jobs/summary');

const TZ = config.sender.timezone;

function guard(name, fn) {
  return () => {
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error(`[cron:${name}]`, e && e.message ? e.message : e));
  };
}

function start() {
  const opts = { timezone: TZ };

  // Sender — every 15 minutes (the job itself enforces the send window).
  cron.schedule('*/15 * * * *', guard('sender', runSender), opts);

  // Reply / bounce watcher — every 30 minutes.
  cron.schedule('*/30 * * * *', guard('watcher', runReplyWatcher), opts);

  // Daily summary — 08:00.
  cron.schedule('0 8 * * *', guard('summary', runDailySummary), opts);

  // Pool refill — 07:30 (only sources if the queue is below the floor).
  cron.schedule('30 7 * * *', guard('refill', () => runPoolRefill(false)), opts);

  console.log(`[scheduler] started (tz=${TZ}). sender/15m, watcher/30m, summary 08:00, refill 07:30.`);
}

module.exports = { start };
