// What to tell the user when the flight changes: the messages, and the macOS notification itself.

import { spawn } from "node:child_process";
import { inAir, position, progress, type Airport, type Flight } from "./flight.ts";
import { oceanName } from "./geo.ts";
import { clock, fmtInt } from "./time.ts";

/** Notify when an estimate moves by this many minutes or more. */
const SHIFT_MIN = 10;

export interface Message {
  text: string;
  sound: boolean;
}

/** What we remember between checks. */
export interface EventState {
  depEst?: number | null;
  arrEst?: number | null;
  lastPos?: number;
}

function gateText(a: Airport, word: "Gate" | "gate"): string {
  return [a.term ? `Terminal ${a.term}` : "", a.gate ? `${word} ${a.gate}` : ""].filter(Boolean).join(" · ");
}

/** The messages for what changed between two checks. */
export function events(prev: Flight, cur: Flight, st: EventState, now: number, posEveryMin: number): Message[] {
  const out: Message[] = [];
  const say = (text: string, sound = false) => out.push({ text, sound });
  const at = (ep: number | null, a: Airport) => clock(ep, a.tz, now, false);

  if (cur.cancelled && !prev.cancelled) say("❌ Flight cancelled.", true);
  if ((cur.diverted && !prev.diverted) || cur.dst.code !== prev.dst.code) say(`⚠️ Diverted to ${cur.dst.code}.`, true);
  if (cur.depA !== null && prev.depA === null) say(`🚪 Left the gate at ${at(cur.depA, cur.org)}.`);
  if (cur.offA !== null && prev.offA === null) {
    say(`🛫 Took off at ${at(cur.offA, cur.org)}. Arrives ~${at(cur.arrE ?? cur.arrS, cur.dst)}.`, true);
    st.lastPos = now;
  }
  if (cur.onA !== null && prev.onA === null) {
    const gate = gateText(cur.dst, "gate");
    say(`🛬 Landed at ${cur.dst.code} at ${at(cur.onA, cur.dst)}.${gate ? ` ${gate}.` : ""}`, true);
  }
  if (cur.arrA !== null && prev.arrA === null) say(`✅ At the gate at ${at(cur.arrA, cur.dst)}.`, true);

  // Estimates: the first one we see is the base. We speak up when it moves far from the last one we told you.
  st.depEst ??= cur.depE;
  st.arrEst ??= cur.arrE;
  const moved = (a: number | null, b: number | null | undefined) =>
    a !== null && b !== null && b !== undefined && Math.abs(a - b) >= SHIFT_MIN * 60;
  if (cur.depA === null && moved(cur.depE, st.depEst)) {
    say(`🕒 Departure now ${at(cur.depE, cur.org)}. It was ${at(st.depEst ?? null, cur.org)}.`);
    st.depEst = cur.depE;
  }
  if (cur.onA === null && moved(cur.arrE, st.arrEst)) {
    say(`🕒 Arrival now ~${at(cur.arrE, cur.dst)}. It was ${at(st.arrEst ?? null, cur.dst)}.`);
    st.arrEst = cur.arrE;
  }

  const gates: [Airport, Airport, string, number | null][] = [
    [cur.org, prev.org, "Departure", cur.depA],
    [cur.dst, prev.dst, "Arrival", cur.arrA],
  ];
  for (const [a, b, where, done] of gates) {
    if (done === null && (a.term || a.gate) && (a.term !== b.term || a.gate !== b.gate)) {
      say(`🚪 ${where} at ${a.code}: ${gateText(a, "gate")}.`);
    }
  }

  if (posEveryMin && inAir(cur) && now - (st.lastPos ?? now) >= posEveryMin * 60) {
    const p = position(cur, now);
    const { fraction, leftKm } = progress(cur, p);
    say(
      `📍 Over ${cur.place || oceanName(p.lat, p.lon)} · ${fmtInt(leftKm)} km to go · ${Math.floor(fraction * 100)}% done`,
    );
    st.lastPos = now;
  }
  return out;
}

/** Show a macOS notification. Does nothing on other systems. */
export function notify(title: string, message: string, sound = false): void {
  const script = `on run argv\n display notification (item 2 of argv) with title (item 1 of argv)${sound ? ' sound name "Glass"' : ""}\nend run`;
  const child = spawn("osascript", ["-e", script, title, message], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
