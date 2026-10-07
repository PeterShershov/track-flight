import assert from "node:assert/strict";
import { test } from "node:test";
import { vlen } from "./ansi.ts";
import { CAPTURED, fixtureFlight } from "./fixture.ts";
import type { Flight } from "./flight.ts";
import { render, type Snapshot } from "./panels.ts";

const NOW = CAPTURED + 60;
const plain = (lines: string[]) =>
  lines.map((l) => l.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")).join("\n");

function app(fl: Flight | null, extra: Partial<Snapshot> = {}): Snapshot {
  return { fl, err: "", checked: NOW, retryAt: 0, interval: 60, notice: "", ...extra };
}

function states(): [string, Flight][] {
  const airborne = fixtureFlight();
  const scheduled = {
    ...fixtureFlight(),
    depA: null,
    offA: null,
    track: [],
    alt: null,
    gs: null,
    elapsedNm: null,
    remainingNm: null,
  };
  const arrived = { ...fixtureFlight(), onA: 1791393900, arrA: 1791394500, alt: null };
  const cancelled = { ...fixtureFlight(), cancelled: true, depA: null, offA: null, track: [] };
  return [
    ["airborne", airborne],
    ["scheduled", scheduled],
    ["arrived", arrived],
    ["cancelled", cancelled],
  ];
}

test("every state fills the screen and never runs wider than it", () => {
  for (const [name, fl] of states()) {
    for (const [w, h] of [
      [80, 20],
      [84, 24],
      [100, 30],
      [120, 36],
      [160, 50],
    ] as const) {
      const lines = render(app(fl), w, h, NOW);
      assert.equal(lines.length, h, `${name} ${w}x${h}: ${lines.length} lines`);
      for (const [i, l] of lines.entries())
        assert.ok(vlen(l) <= w, `${name} ${w}x${h} line ${i + 1} is ${vlen(l)} wide`);
    }
  }
});

test("an airborne flight shows what you need", () => {
  const text = plain(render(app(fixtureFlight()), 120, 36, NOW));
  for (const want of [
    "UNITED 125",
    "AIRBORNE",
    "38 MIN EARLY",
    "COCKPIT",
    "10,970 m",
    "FL360",
    "928 km/h",
    "North Atlantic Ocean",
    "DEPARTURE · ATH",
    "ARRIVAL · EWR",
    "Terminal B",
    "13:27 EDT",
    "10:33 EEST",
    "landing in",
    "km flown",
    "q quit",
  ]) {
    assert.ok(text.includes(want), `missing "${want}"`);
  }
});

test("the cockpit panel needs 100 columns", () => {
  assert.ok(!plain(render(app(fixtureFlight()), 99, 30, NOW)).includes("COCKPIT"));
  assert.ok(plain(render(app(fixtureFlight()), 100, 30, NOW)).includes("COCKPIT"));
});

test("a flight that has not left says when it departs", () => {
  const threeHoursBefore = 1791358500 - 3 * 3600;
  const text = plain(render(app(states()[1]?.[1] ?? null), 120, 36, threeHoursBefore));
  assert.ok(text.includes("SCHEDULED"));
  assert.ok(text.includes("On the ground"));
  assert.match(text, /departs in 3h 00m/);
});

test("an arrived flight says when it landed", () => {
  const text = plain(render(app(states()[2]?.[1] ?? null), 120, 36, 1791395000));
  assert.ok(text.includes("ARRIVED"));
  assert.match(text, /landed 18 min ago/);
});

test("the loading screen shows the error and the retry time", () => {
  const text = plain(
    render(app(null, { err: "FlightAware is limiting requests (HTTP 429)", retryAt: NOW + 240 }), 100, 30, NOW),
  );
  assert.ok(text.includes("Contacting FlightAware"));
  assert.ok(text.includes("HTTP 429"));
  assert.ok(text.includes("retrying in 4 min"));
  assert.ok(!plain(render(app(null), 100, 30, NOW)).includes("HTTP"));
});

test("the footer shows a notice, an offline state and stale data", () => {
  assert.ok(plain(render(app(fixtureFlight(), { notice: "refreshing…" }), 120, 36, NOW)).includes("refreshing…"));
  const offline = plain(render(app(fixtureFlight(), { err: "boom", retryAt: NOW + 30 }), 120, 36, NOW));
  assert.ok(offline.includes("offline") && offline.includes("boom") && offline.includes("retrying in 30s"));
  assert.ok(plain(render(app(fixtureFlight(), { checked: NOW - 1000 }), 120, 36, NOW)).includes("stale"));
});

test("a terminal that is too small gets a plain message", () => {
  assert.match(plain(render(app(fixtureFlight()), 60, 15, NOW)), /too small: 60x15/);
});
