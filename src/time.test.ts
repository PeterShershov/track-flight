import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, dayLabel, fmtDur, fmtInt, localDate, zoneAbbr } from "./time.ts";

// 13:27 in New York, 20:27 in Athens, on Wed 7 Oct 2026.
const T = 1791394020;

test("clock shows local time with the zone's own name", () => {
  assert.equal(clock(T, "America/New_York", T), "13:27 EDT");
  assert.equal(clock(T, "Europe/Athens", T), "20:27 EEST");
  assert.equal(clock(T, "Europe/London", T), "18:27 BST");
  assert.equal(clock(T, "America/New_York", T, false), "13:27");
});

test("clock adds the weekday when the day is not today", () => {
  assert.equal(clock(T, "America/New_York", T + 86_400, false), "Wed 13:27");
  assert.equal(clock(T, "America/New_York", T - 3600, false), "13:27");
});

test("clock handles a missing time and a bad zone", () => {
  assert.equal(clock(null, "Europe/Athens", T), "—");
  assert.equal(clock(T, "Not/AZone", T, false), "17:27");
});

test("a zone with no short name shows its offset", () => {
  assert.match(zoneAbbr(T, "Asia/Kolkata"), /^(GMT|UTC)\+5:30$|^IST$/);
});

test("midnight is 00:xx, not 24:xx", () => {
  assert.equal(clock(Date.UTC(2026, 9, 7, 0, 5) / 1000, "UTC", Date.UTC(2026, 9, 7) / 1000, false), "00:05");
});

test("localDate and dayLabel use the zone's calendar", () => {
  const lateNewYork = Date.UTC(2026, 9, 8, 2, 0) / 1000; // 22:00 on the 7th in New York
  assert.equal(localDate(lateNewYork, "America/New_York"), "2026-10-07");
  assert.equal(localDate(lateNewYork, "Europe/Athens"), "2026-10-08");
  assert.equal(dayLabel(T, "America/New_York"), "Wed 7 Oct");
  assert.equal(dayLabel(T, "America/New_York", true), "Wed 7 Oct 2026");
});

test("fmtDur", () => {
  assert.equal(fmtDur(30), "<1 min");
  assert.equal(fmtDur(41 * 60), "41 min");
  assert.equal(fmtDur(2 * 3600 + 41 * 60), "2h 41m");
  assert.equal(fmtDur(3600 + 5 * 60), "1h 05m");
  assert.equal(fmtDur(-50), "<1 min");
});

test("fmtInt adds thousands separators", () => {
  assert.equal(fmtInt(36000), "36,000");
  assert.equal(fmtInt(927.6), "928");
  assert.equal(fmtInt(12), "12");
});
