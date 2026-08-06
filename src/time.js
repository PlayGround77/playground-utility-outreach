'use strict';

const config = require('./config');
const TZ = config.sender.timezone;

/** 'YYYY-MM-DD' in the configured timezone. */
function todayStamp(date) {
  const d = date || new Date();
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

/** 'DD.MM' in the configured timezone (used for daily/pool group names). */
function dayMonthLabel(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: '2-digit'
  }).formatToParts(d);
  const day = parts.find((p) => p.type === 'day').value;
  const month = parts.find((p) => p.type === 'month').value;
  return day + '.' + month;
}

/** Hour (0-23) in the configured timezone. */
function hour(date) {
  const d = date || new Date();
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false
  }).format(d).replace(/[^0-9]/g, ''));
}

/** Minute (0-59) in the configured timezone. */
function minute(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, minute: '2-digit'
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'minute').value);
}

/** JS getDay-style weekday (0=Sun..6=Sat) in the configured timezone. */
function weekday(date) {
  const d = date || new Date();
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
}

/** Whole days between two 'YYYY-MM-DD' stamps (Infinity if `from` falsy). */
function daysBetween(fromStamp, toStamp) {
  if (!fromStamp) return Infinity;
  const a = new Date(fromStamp + 'T00:00:00Z');
  const b = new Date((toStamp || todayStamp()) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { todayStamp, dayMonthLabel, hour, minute, weekday, daysBetween, sleep, TZ };
