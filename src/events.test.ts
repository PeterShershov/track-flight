import assert from "node:assert/strict";
import { test } from "node:test";
import { events, type EventState } from "./events.ts";
import { CAPTURED, fixtureFlight } from "./fixture.ts";
import type { Flight } from "./flight.ts";

const NOW = CAPTURED + 100;

/** Apply a change to the flight, then say what events() reports. */
function step(prev: Flight, change: (f: Flight) => void, st: EventState, now = NOW): { cur: Flight; texts: string[] } {
  const cur = structuredClone(prev);
  change(cur);
  return { cur, texts: events(prev, cur, st, now, 30).map((m) => m.text) };
}

test("nothing changed, nothing said", () => {
  const fl = fixtureFlight();
  assert.deepEqual(step(fl, () => {}, {}).texts, []);
});

test("a big move of the arrival estimate is reported once, small ones are not", () => {
  const st: EventState = {};
  const fl = fixtureFlight();
  events(fl, fl, st, NOW, 30); // the first check sets the base
  const small = step(fl, (f) => (f.arrE = (f.arrE ?? 0) + 300), st);
  assert.deepEqual(small.texts, []);
  const big = step(small.cur, (f) => (f.arrE = (f.arrE ?? 0) + 900), st);
  assert.equal(big.texts.length, 1);
  assert.match(big.texts[0] ?? "", /Arrival now ~13:47\. It was 13:27\./);
  assert.deepEqual(step(big.cur, () => {}, st).texts, []);
});

test("a new gate is reported", () => {
  const { texts } = step(
    fixtureFlight(),
    (f) => {
      f.dst.gate = "C71";
      f.dst.term = "C";
    },
    {},
  );
  assert.deepEqual(texts, ["🚪 Arrival at EWR: Terminal C · gate C71."]);
});

test("landing, then the gate, play a sound", () => {
  const fl = fixtureFlight();
  const landed = structuredClone(fl);
  landed.onA = 1791393900;
  const [m1] = events(fl, landed, {}, NOW, 30);
  assert.equal(m1?.sound, true);
  assert.match(m1?.text ?? "", /Landed at EWR at 13:25\. Terminal B\./);
  const atGate = structuredClone(landed);
  atGate.arrA = 1791394500;
  const [m2] = events(landed, atGate, {}, NOW, 30);
  assert.match(m2?.text ?? "", /At the gate at 13:35\./);
  assert.equal(m2?.sound, true);
});

test("takeoff is reported with the arrival time", () => {
  const fl = fixtureFlight();
  fl.offA = null;
  const { texts } = step(fl, (f) => (f.offA = 1791360300), {});
  assert.match(texts[0] ?? "", /Took off at 11:05\. Arrives ~13:27\./);
});

test("cancellation and diversion", () => {
  assert.deepEqual(step(fixtureFlight(), (f) => (f.cancelled = true), {}).texts, ["❌ Flight cancelled."]);
  assert.deepEqual(step(fixtureFlight(), (f) => (f.dst.code = "BOS"), {}).texts, ["⚠️ Diverted to BOS."]);
});

test("a position update comes when the timer is due, and not before", () => {
  const fl = fixtureFlight();
  const st: EventState = { lastPos: NOW - 600 };
  assert.deepEqual(step(fl, () => {}, st).texts, []);
  st.lastPos = NOW - 1900;
  const { texts } = step(fl, () => {}, st);
  assert.equal(texts.length, 1);
  assert.match(texts[0] ?? "", /Over North Atlantic Ocean · [\d,]+ km to go · \d+% done/);
  assert.equal(st.lastPos, NOW);
  assert.deepEqual(events(fl, fl, { lastPos: NOW - 99_999 }, NOW, 0), []);
});
