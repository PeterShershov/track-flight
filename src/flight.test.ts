import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURED, fixtureFlight } from "./fixture.ts";
import { deltaMinutes, deltaText, inAir, parseFlight, phase, position, progress, titleCase } from "./flight.ts";
import { havKm } from "./geo.ts";

const near = (a: number, b: number, tol: number) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("parseFlight reads the real flight", () => {
  const fl = fixtureFlight();
  assert.equal(fl.name, "United 125");
  assert.equal(fl.aircraft, "Boeing 787-10 Dreamliner");
  assert.equal(fl.org.code, "ATH");
  assert.equal(fl.org.tz, "Europe/Athens");
  assert.equal(fl.org.gate, "A5");
  assert.equal(fl.dst.code, "EWR");
  assert.equal(fl.dst.tz, "America/New_York");
  assert.equal(fl.depA, 1791358380);
  assert.equal(fl.offA, 1791360300);
  assert.equal(fl.arrE, 1791394020);
  assert.equal(fl.onA, null);
  assert.equal(fl.track.length, 51);
  assert.ok(fl.waypoints.length > 5);
  assert.equal(fl.stamp, CAPTURED);
});

test('parseFlight turns the "BHOLD" gate into terminal B', () => {
  const fl = fixtureFlight();
  assert.equal(fl.dst.gate, "");
  assert.equal(fl.dst.term, "B");
});

test("parseFlight returns null when there is no flight", () => {
  assert.equal(parseFlight(undefined), null);
  assert.equal(parseFlight({}), null);
  assert.equal(parseFlight("nope"), null);
  assert.equal(parseFlight({ displayIdent: "" }), null);
});

test("parseFlight survives missing and wrong-typed fields", () => {
  const fl = parseFlight({
    displayIdent: "XX1",
    track: [{ coord: "bad" }, { timestamp: 1, coord: [1, 2] }],
    altitude: "high",
    origin: 5,
  });
  assert.ok(fl);
  assert.equal(fl.track.length, 1);
  assert.equal(fl.alt, null);
  assert.equal(fl.org.code, "???");
  assert.equal(fl.org.tz, "UTC");
  assert.equal(fl.name, "XX1");
});

test("titleCase", () => {
  assert.equal(titleCase("BOEING 787-10 Dreamliner"), "Boeing 787-10 Dreamliner");
  assert.equal(titleCase("AIRBUS A320-232"), "Airbus A320-232");
  assert.equal(titleCase(""), "");
});

test("phase follows the flight from gate to gate", () => {
  const fl = fixtureFlight();
  assert.equal(phase(fl).label, "AIRBORNE");
  assert.ok(inAir(fl));

  const before = { ...fl, depA: null, offA: null, track: [] };
  assert.equal(phase({ ...before, depE: before.depS }).label, "SCHEDULED");
  assert.equal(phase({ ...before, depE: (before.depS ?? 0) + 1200 }).label, "DELAYED");
  assert.equal(phase({ ...before, depA: 1 }).label, "TAXIING OUT");
  assert.equal(phase({ ...fl, onA: 1 }).label, "TAXIING IN");
  assert.equal(phase({ ...fl, onA: 1, arrA: 2 }).label, "ARRIVED");
  assert.equal(phase({ ...fl, cancelled: true }).label, "CANCELLED");
  assert.equal(phase({ ...fl, diverted: true }).label, "DIVERTED");
  assert.ok(!inAir({ ...fl, onA: 1 }));
});

test("deltaMinutes and deltaText", () => {
  assert.equal(deltaMinutes(1000 + 600, 1000), 10);
  assert.equal(deltaMinutes(null, 1000), null);
  assert.equal(deltaText(null).text, "");
  assert.equal(deltaText(3).text, "on time");
  assert.equal(deltaText(-38).text, "38 min early");
  assert.equal(deltaText(12).text, "12 min late");
  assert.notDeepEqual(deltaText(12).color, deltaText(45).color);
});

test("position is the last known point when the data is fresh", () => {
  const fl = fixtureFlight();
  const last = fl.track.at(-1);
  assert.ok(last);
  const p = position(fl, CAPTURED);
  near(p.lat, last.lat, 1e-6);
  near(p.lon, last.lon, 1e-6);
  assert.ok(p.est);
  assert.ok(p.brg > 240 && p.brg < 290, `the plane flies west, not ${p.brg}`);
});

test("position flies on from old data, but for 20 minutes at most", () => {
  const fl = fixtureFlight();
  const last = fl.track.at(-1);
  assert.ok(last);
  const km = (now: number) => {
    const p = position(fl, now);
    return havKm(last.lat, last.lon, p.lat, p.lon);
  };
  near(km(CAPTURED + 120), (501 * 1.852 * 120) / 3600, 1.5);
  assert.equal(km(CAPTURED + 100_000), km(CAPTURED + 1200));
});

test("position is at the airport before takeoff and after landing", () => {
  const fl = fixtureFlight();
  const before = position({ ...fl, offA: null, depA: null, track: [] }, CAPTURED);
  assert.equal(before.lat, fl.org.lat);
  assert.equal(position({ ...fl, onA: 1 }, CAPTURED).lat, fl.dst.lat);
  assert.equal(position({ ...fl, arrA: 1 }, CAPTURED).lon, fl.dst.lon);
});

test("progress", () => {
  const fl = fixtureFlight();
  const mid = progress(fl, position(fl, CAPTURED));
  near(mid.fraction, 2684 / (2684 + 1733), 0.01);
  near(mid.doneKm, 2684 * 1.852, 5);
  near(mid.leftKm, 1733 * 1.852, 5);

  const direct = havKm(fl.org.lat, fl.org.lon, fl.dst.lat, fl.dst.lon);
  const start = progress({ ...fl, offA: null, track: [] }, position(fl, CAPTURED));
  assert.equal(start.fraction, 0);
  near(start.leftKm, direct, 0.01);
  const end = progress({ ...fl, onA: 1 }, position(fl, CAPTURED));
  assert.equal(end.fraction, 1);
  assert.equal(end.leftKm, 0);
});

test("progress works from the track when FlightAware gives no distance", () => {
  const fl = { ...fixtureFlight(), elapsedNm: null, remainingNm: null };
  const p = progress(fl, position(fl, CAPTURED));
  assert.ok(p.fraction > 0.4 && p.fraction < 0.8, String(p.fraction));
});
