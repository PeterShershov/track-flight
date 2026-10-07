// Everything on the screen except the map. `render` lays it all out.

import { box, hjoin, mix, P, paint, pill, rightAlign, vlen, type Rgb } from "./ansi.ts";
import {
  deltaMinutes,
  deltaText,
  inAir,
  KM_PER_NM,
  phase,
  position,
  progress,
  type Airport,
  type Flight,
  type Position,
} from "./flight.ts";
import { oceanName, sunElevation, sunState } from "./geo.ts";
import { ARROWS, compassIndex, COMPASS, renderMap } from "./map.ts";
import { clock, dayLabel, fmtDur, fmtInt, zoneAbbr, zoneParts } from "./time.ts";

/** What the screen needs to know about the app. */
export interface Snapshot {
  fl: Flight | null;
  err: string;
  /** When we last got data, in Unix seconds. */
  checked: number;
  /** When we try again after an error, in Unix seconds. */
  retryAt: number;
  interval: number;
  /** A short message for the footer, such as "refreshing…". Empty for none. */
  notice: string;
}

const SPARK = "▁▂▃▄▅▆▇█";

/** A one-line graph of values. `hi` is the value that fills the tallest bar. */
export function spark(vals: readonly number[], width: number, hi: number): string {
  if (!vals.length) return paint("no data yet", P.dim);
  let out = "";
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i * vals.length) / width);
    const seg = vals.slice(from, Math.max(from + 1, Math.floor(((i + 1) * vals.length) / width)));
    const v = seg.reduce((a, b) => a + b, 0) / seg.length;
    const lvl = Math.max(0, Math.min(7, Math.floor((v / hi) * 7.999)));
    out += paint(SPARK.charAt(lvl), mix([64, 104, 156], P.acc, lvl / 7));
  }
  return out;
}

const meters = (hundredsOfFeet: number) => Math.round((hundredsOfFeet * 30.48) / 10) * 10;
const label = (s: string) => paint(s, P.dim);

function gauges(fl: Flight, pos: Position, now: number, w: number, h: number): string[] {
  const iw = w - 4;
  const air = inAir(fl);
  const histAlt = fl.track.flatMap((t) => (t.alt === null ? [] : [t.alt]));
  const histGs = fl.track.flatMap((t) => (t.gs === null ? [] : [t.gs]));

  const alt =
    !air || fl.alt === null
      ? paint("On the ground", P.dim)
      : paint(`${fmtInt(meters(fl.alt))} m`, P.txt, true) +
        paint(`   FL${String(Math.trunc(fl.alt)).padStart(3, "0")}`, P.dim);
  const gs = !air || fl.gs === null ? paint("—", P.dim) : paint(`${fmtInt(fl.gs * KM_PER_NM)} km/h`, P.txt, true);
  const d = compassIndex(pos.brg);
  const hdg = !air
    ? paint("—", P.dim)
    : paint(`${String(Math.round(pos.brg)).padStart(3, "0")}°`, P.txt, true) +
      paint(`  ${COMPASS[d] ?? ""}  `, P.dim) +
      paint(ARROWS.charAt(d), P.flown, true);
  const lat = `${Math.abs(pos.lat).toFixed(2)}°${pos.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(pos.lon).toFixed(2)}°${pos.lon >= 0 ? "E" : "W"}`;
  const elev = sunElevation(pos.lat, pos.lon, sunState(now));
  const sun =
    elev > 0 ? paint("☀ Daylight", P.flown) : elev > -6 ? paint("☾ Twilight", P.acc) : paint("☾ Night", P.acc);

  const sections = [
    [label("ALTITUDE"), alt, spark(histAlt, iw, Math.max(...histAlt, 400))],
    [label("GROUND SPEED"), gs, spark(histGs, iw, Math.max(...histGs, 500))],
    [label("HEADING"), hdg],
    [label("POSITION"), paint(`${lat}  ${lon}`, P.txt, true), paint(fl.place || oceanName(pos.lat, pos.lon), P.dim)],
    [label("SUN AT PLANE"), sun],
    [label("AIRCRAFT"), paint(fl.aircraft || "—", P.txt)],
  ];
  // Keep as many sections as fit. Drop the blank lines between them first, then the last sections.
  const ih = h - 2;
  const height = (secs: string[][], gap: number) => secs.reduce((n, s) => n + s.length, 0) + gap * (secs.length - 1);
  let gap = 1;
  let shown = sections;
  for (gap of [1, 0]) {
    shown = [...sections];
    while (shown.length > 1 && height(shown, gap) > ih) shown.pop();
    if (height(shown, gap) <= ih) break;
  }
  const lines = shown.flatMap((s) => (gap ? [...s, ""] : s));
  return box(lines, w, h, { title: paint("COCKPIT", P.acc, true) });
}

/** One "label  value  note  extra" line. The extra part is dropped when the line is too long. */
function timeRow(name: string, value: string, note = "", noteColor: Rgb = P.dim, extra = "", width = 999): string {
  const row = paint(name.padEnd(10), P.dim) + value + (note ? "  " + paint(note, noteColor) : "");
  const full = row + (extra ? "  " + paint(extra, P.dim) : "");
  return vlen(full) <= width ? full : row;
}

function airportBox(fl: Flight, a: Airport, now: number, w: number, h: number, departure: boolean): string[] {
  const iw = w - 4;
  const gate = [a.term ? `Terminal ${a.term}` : "", a.gate ? `Gate ${a.gate}` : ""].filter(Boolean).join(" · ");
  const head = gate ? paint(gate, P.txt, true) : paint("Gate not assigned yet", P.dim);
  const at = (ep: number | null) => (ep === null ? paint("—", P.dim) : paint(clock(ep, a.tz, now), P.txt, true));
  const sched = (ep: number | null) => (ep === null ? "" : `sched ${clock(ep, a.tz, now, false)}`);
  const p = zoneParts(now, a.tz);
  const localRow = timeRow(
    "Local",
    paint(`${p.hour}:${p.minute} ${zoneAbbr(now, a.tz)}`, P.txt, true),
    dayLabel(now, a.tz),
  );

  if (departure) {
    const best = fl.depA ?? fl.depE;
    const { text, color } = deltaText(deltaMinutes(best, fl.depS));
    const rows = [
      head,
      timeRow("Left gate", at(best), text, color, sched(fl.depS), iw),
      timeRow("Took off", at(fl.offA)),
      localRow,
    ];
    return box(rows, w, h, { title: paint(`DEPARTURE · ${a.code}`, P.org, true), right: paint(a.city, P.dim) });
  }
  const best = fl.arrA ?? fl.arrE;
  const { text, color } = deltaText(deltaMinutes(best, fl.arrS));
  const landing = fl.onA ?? fl.onE;
  const rows = [
    head,
    timeRow("Landing", at(landing), fl.onA === null ? "estimated" : ""),
    timeRow("At gate", at(best), text, color, sched(fl.arrS), iw),
    localRow,
  ];
  return box(rows, w, h, { title: paint(`ARRIVAL · ${a.code}`, P.dst, true), right: paint(a.city, P.dim) });
}

function header(fl: Flight, now: number, w: number): string[] {
  const { label: name, color } = phase(fl);
  const status = pill(`${Math.floor(now) % 2 ? "●" : "○"} ${name}`, color);
  const landed = ["AIRBORNE", "TAXIING IN", "ARRIVED", "TAXIING OUT"].includes(name);
  const { text, color: tagColor } = landed
    ? deltaText(deltaMinutes(fl.arrA ?? fl.arrE, fl.arrS))
    : deltaText(deltaMinutes(fl.depA ?? fl.depE, fl.depS));
  const tag = text ? pill(text.toUpperCase(), tagColor) + " " : "";
  const l1 =
    " " +
    paint("✈", P.flown, true) +
    " " +
    paint(fl.name.toUpperCase(), P.txt, true) +
    paint(fl.aircraft ? `   ${fl.aircraft}` : "", P.dim);
  const day = dayLabel(fl.depS ?? fl.depE ?? now, fl.org.tz, true);
  const l2 =
    " " +
    paint(fl.org.code, P.org, true) +
    paint(` ${fl.org.city}`, P.txt) +
    paint("   ───►   ", P.dim) +
    paint(fl.dst.code, P.dst, true) +
    paint(` ${fl.dst.city}`, P.txt);
  return [
    rightAlign(l1, tag + status + " ", w),
    rightAlign(l2, paint(day + " ", P.dim), w),
    paint("─".repeat(w), P.line),
  ];
}

function progressLines(fl: Flight, pos: Position, now: number, w: number, wide: boolean): string[] {
  const { fraction, doneKm, leftKm } = progress(fl, pos);
  const left = paint(` ${fl.org.code} `, P.org, true);
  const right = paint(` ${fl.dst.code} `, P.dst, true);
  const pct = paint(`${String(Math.floor(fraction * 100)).padStart(3)}% `, P.txt, true);
  const bw = Math.max(10, w - vlen(left) - vlen(right) - vlen(pct));
  const at = Math.min(bw - 1, Math.floor(fraction * (bw - 1)));
  let bar = "";
  for (let i = 0; i < bw; i++) {
    if (i === at && fraction > 0) bar += paint("✈", P.txt, true);
    else if (i < at) bar += paint("━", mix(P.acc, P.flown, i / Math.max(bw - 1, 1)));
    else bar += paint("╌", P.line);
  }

  const val = (s: string) => paint(s, P.txt, true);
  const sep = paint("  ·  ", P.line);
  const parts: string[] = [];
  const air = inAir(fl);
  if (wide) {
    parts.push(val(fmtInt(doneKm)) + paint(" km flown", P.dim), val(fmtInt(leftKm)) + paint(" km to go", P.dim));
  } else if (air && fl.alt !== null && fl.gs !== null) {
    parts.push(
      val(`${fmtInt(meters(fl.alt))} m`),
      val(`${fmtInt(fl.gs * KM_PER_NM)} km/h`),
      val(`${fmtInt(leftKm)} km`) + paint(" to go", P.dim),
    );
  } else {
    parts.push(val(fmtInt(leftKm)) + paint(" km to go", P.dim));
  }
  const landing = fl.onA ?? fl.onE ?? fl.onS;
  const departs = fl.depE ?? fl.depS;
  if (fl.cancelled) parts.push(paint("cancelled", P.bad, true));
  else if (fl.arrA !== null || fl.onA !== null)
    parts.push(paint("landed ", P.dim) + val(`${fmtDur(now - (fl.onA ?? fl.arrA ?? now))} ago`));
  else if (air && landing !== null) {
    parts.push(
      landing > now ? paint("landing in ", P.dim) + val(fmtDur(landing - now)) : paint("landing any moment", P.dim),
    );
  } else if (fl.depA !== null) parts.push(paint("taxiing to the runway", P.dim));
  else if (departs !== null) {
    parts.push(
      departs > now ? paint("departs in ", P.dim) + val(fmtDur(departs - now)) : paint("departure due", P.warn),
    );
  }
  const arrives = fl.arrE ?? fl.arrS;
  if (wide && fl.arrA === null && fl.onA === null && arrives !== null) {
    parts.push(paint("arrives ", P.dim) + val(clock(arrives, fl.dst.tz, now)));
  }
  const l2 = parts.join(sep);
  return [left + bar + right + pct, " ".repeat(Math.max(0, Math.floor((w - vlen(l2)) / 2))) + l2];
}

function retryText(app: Snapshot, now: number): string {
  const left = Math.floor(app.retryAt - now);
  if (!app.retryAt || left < 0) return "retrying";
  return `retrying in ${left < 60 ? `${left}s` : fmtDur(left)}`;
}

function footer(app: Snapshot, w: number, now: number): string {
  const help: [string, string][] = [
    ["q", "quit"],
    ["r", "refresh"],
  ];
  const keys = help.map(([k, v]) => paint(k, P.txt, true) + paint(` ${v}`, P.dim)).join("  ");
  let status: string;
  if (app.err) {
    status = paint("● offline", P.bad, true) + paint(` · ${app.err.slice(0, 55)} · ${retryText(app, now)}`, P.dim);
  } else {
    const age = app.checked ? Math.max(0, now - app.checked) : 0;
    const fresh = age < app.interval * 2 + 5;
    status = paint(fresh ? "● live" : "● stale", fresh ? P.ok : P.warn, true);
    status += paint(` · checked ${age >= 60 ? fmtDur(age) : `${Math.floor(age)}s`} ago`, P.dim);
    if (app.fl?.stamp) status += paint(` · FlightAware data ${fmtDur(now - app.fl.stamp)} old`, P.dim);
  }
  return rightAlign(" " + keys + (app.notice ? "   " + paint(app.notice, P.warn, true) : ""), status + " ", w);
}

/** The whole screen, as lines of text. */
export function render(app: Snapshot, W: number, H: number, now: number): string[] {
  const fl = app.fl;
  if (W < 80 || H < 20) return [paint(`Terminal too small: ${W}x${H}. Need at least 80x20.`, P.warn)];
  if (!fl) {
    const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".charAt(Math.floor(now * 8) % 10);
    const lines = Array<string>(Math.max(0, Math.floor(H / 2) - 2)).fill("");
    lines.push(
      " ".repeat(Math.max(0, Math.floor((W - 28) / 2))) + paint(`${spin}  Contacting FlightAware…`, P.acc, true),
    );
    if (app.err)
      lines.push("", "  " + paint(app.err, P.bad), "  " + paint(`${retryText(app, now)}. Press r to try now.`, P.dim));
    return lines;
  }

  const pos = position(fl, now);
  const wide = W >= 100;
  const boxH = 6;
  const mapH = H - 3 - 2 - boxH - 1;
  const legend = paint("━", P.flown) + paint(" flown  ", P.dim) + paint("┄", P.plan) + paint(" planned", P.dim);
  const mapBox = (width: number) =>
    box(renderMap(fl, pos, width - 2, mapH - 2, now), width, mapH, {
      title: paint("ROUTE", P.acc, true),
      right: legend,
      pad: 0,
    });

  const lines = header(fl, now, W);
  if (wide) lines.push(...hjoin([mapBox(W - 34 - 1), gauges(fl, pos, now, 34, mapH)]));
  else lines.push(...mapBox(W));
  lines.push(...progressLines(fl, pos, now, W, wide));
  const half = Math.floor((W - 1) / 2);
  lines.push(
    ...hjoin([airportBox(fl, fl.org, now, half, boxH, true), airportBox(fl, fl.dst, now, W - half - 1, boxH, false)]),
  );
  lines.push(footer(app, W, now));
  return lines;
}
