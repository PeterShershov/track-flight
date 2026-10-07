// The flight itself: what FlightAware tells us, and what we work out from it.

import { P, type Rgb } from "./ansi.ts";
import { bearing, destination, havKm } from "./geo.ts";
import { bool, list, num, rec, str } from "./json.ts";

export const KM_PER_NM = 1.852;

export interface Airport {
  code: string;
  city: string;
  lon: number;
  lat: number;
  /** IANA zone name, such as "America/New_York". */
  tz: string;
  gate: string;
  term: string;
}

export interface TrackPoint {
  ts: number;
  lon: number;
  lat: number;
  /** Altitude in hundreds of feet (flight level). */
  alt: number | null;
  /** Ground speed in knots. */
  gs: number | null;
}

/** Times are Unix seconds. S is scheduled, E is estimated, A is actual. */
export interface Flight {
  name: string;
  aircraft: string;
  org: Airport;
  dst: Airport;
  depS: number | null;
  depE: number | null;
  depA: number | null;
  offA: number | null;
  onS: number | null;
  onE: number | null;
  onA: number | null;
  arrS: number | null;
  arrE: number | null;
  arrA: number | null;
  cancelled: boolean;
  diverted: boolean;
  track: TrackPoint[];
  waypoints: [number, number][];
  alt: number | null;
  gs: number | null;
  hdg: number | null;
  elapsedNm: number | null;
  remainingNm: number | null;
  stamp: number | null;
  /** Name of the region under the plane. Filled in by the app. */
  place: string;
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase());
}

function parseAirport(v: unknown): Airport {
  const a = rec(v);
  const c = list(a["coord"]);
  let gate = str(a["gate"]);
  let term = str(a["terminal"]);
  const hold = /^([A-Z])HOLD$/.exec(gate); // FlightAware says "BHOLD" for "terminal B, no gate yet".
  if (hold) {
    gate = "";
    term = term || (hold[1] ?? "");
  }
  return {
    code: str(a["iata"]) || str(a["icao"]) || "???",
    city: str(a["friendlyLocation"]) || str(a["friendlyName"]),
    lon: num(c[0]) ?? 0,
    lat: num(c[1]) ?? 0,
    tz: str(a["TZ"]).replace(/^:/, "") || "UTC",
    gate,
    term,
  };
}

/** Build a Flight from one flight object of FlightAware's page data. Returns null when it holds no flight. */
export function parseFlight(raw: unknown): Flight | null {
  const f = rec(raw);
  if (!str(f["displayIdent"])) return null;

  const times = (key: string): [number | null, number | null, number | null] => {
    const t = rec(f[key]);
    return [num(t["scheduled"]), num(t["estimated"]), num(t["actual"])];
  };
  const [depS, depE, depA] = times("gateDepartureTimes");
  const [, , offA] = times("takeoffTimes");
  const [onS, onE, onA] = times("landingTimes");
  const [arrS, arrE, arrA] = times("gateArrivalTimes");

  const track: TrackPoint[] = [];
  for (const item of list(f["track"])) {
    const p = rec(item);
    const c = list(p["coord"]);
    const ts = num(p["timestamp"]);
    const lon = num(c[0]);
    const lat = num(c[1]);
    if (ts !== null && lon !== null && lat !== null) track.push({ ts, lon, lat, alt: num(p["alt"]), gs: num(p["gs"]) });
  }
  const waypoints: [number, number][] = [];
  for (const item of list(f["waypoints"])) {
    const w = list(item);
    const lon = num(w[0]);
    const lat = num(w[1]);
    if (lon !== null && lat !== null) waypoints.push([lon, lat]);
  }
  const dist = rec(f["distance"]);

  return {
    name: str(f["friendlyIdent"]) || str(f["displayIdent"]),
    aircraft: titleCase(str(rec(f["aircraft"])["friendlyType"]).replace(/\s*\(.*\)$/, "")),
    org: parseAirport(f["origin"]),
    dst: parseAirport(f["destination"]),
    depS,
    depE,
    depA,
    offA,
    onS,
    onE,
    onA,
    arrS,
    arrE,
    arrA,
    cancelled: bool(f["cancelled"]),
    diverted: bool(f["diverted"]),
    track,
    waypoints,
    alt: num(f["altitude"]),
    gs: num(f["groundspeed"]),
    hdg: num(f["heading"]),
    elapsedNm: num(dist["elapsed"]),
    remainingNm: num(dist["remaining"]),
    stamp: num(f["timestamp"]),
    place: "",
  };
}

export function inAir(fl: Flight): boolean {
  return fl.offA !== null && fl.onA === null;
}

export interface Phase {
  label: string;
  color: Rgb;
}

export function phase(fl: Flight): Phase {
  if (fl.cancelled) return { label: "CANCELLED", color: P.bad };
  if (fl.diverted) return { label: "DIVERTED", color: P.bad };
  if (fl.arrA !== null) return { label: "ARRIVED", color: P.ok };
  if (fl.onA !== null) return { label: "TAXIING IN", color: P.ok };
  if (fl.offA !== null) return { label: "AIRBORNE", color: P.acc };
  if (fl.depA !== null) return { label: "TAXIING OUT", color: P.warn };
  if (fl.depS !== null && (fl.depE ?? fl.depS) - fl.depS >= 900) return { label: "DELAYED", color: P.warn };
  return { label: "SCHEDULED", color: P.dim };
}

/** Minutes between two times (a minus b), or null when one is missing. */
export function deltaMinutes(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.round((a - b) / 60);
}

/** Words and a color for a time against its schedule. */
export function deltaText(mins: number | null): { text: string; color: Rgb } {
  if (mins === null) return { text: "", color: P.dim };
  if (Math.abs(mins) < 5) return { text: "on time", color: P.ok };
  if (mins < 0) return { text: `${-mins} min early`, color: P.ok };
  return { text: `${mins} min late`, color: mins >= 30 ? P.bad : P.warn };
}

export interface Position {
  lat: number;
  lon: number;
  /** Direction of travel, in degrees from north. */
  brg: number;
  /** True when we moved the plane forward from its last known point. */
  est: boolean;
}

/** Best guess of where the plane is now. FlightAware's last point can be minutes old, so we fly on from it. */
export function position(fl: Flight, now: number): Position {
  const { org, dst } = fl;
  const route = bearing(org.lat, org.lon, dst.lat, dst.lon);
  if (fl.arrA !== null || fl.onA !== null) return { lat: dst.lat, lon: dst.lon, brg: route, est: false };
  const last = fl.track.at(-1);
  if (fl.offA === null || !last) return { lat: org.lat, lon: org.lon, brg: route, est: false };

  let brg = fl.hdg ?? bearing(last.lat, last.lon, dst.lat, dst.lon);
  for (const p of fl.track.slice(-30, -1).reverse()) {
    if (havKm(p.lat, p.lon, last.lat, last.lon) >= 1) {
      brg = bearing(p.lat, p.lon, last.lat, last.lon);
      break;
    }
  }
  let { lat, lon } = last;
  const speed = last.gs ?? fl.gs;
  const age = Math.max(0, Math.min(now - last.ts, 1200));
  if (speed && age) {
    const km = (speed * KM_PER_NM * age) / 3600;
    if (km < havKm(lat, lon, dst.lat, dst.lon)) [lat, lon] = destination(lat, lon, brg, km);
    else [lat, lon] = [dst.lat, dst.lon];
  }
  return { lat, lon, brg, est: true };
}

export interface Progress {
  /** From 0 to 1. */
  fraction: number;
  doneKm: number;
  leftKm: number;
}

export function progress(fl: Flight, pos: Position): Progress {
  const direct = havKm(fl.org.lat, fl.org.lon, fl.dst.lat, fl.dst.lon);
  if (fl.arrA !== null || fl.onA !== null) {
    return { fraction: 1, doneKm: fl.elapsedNm !== null ? fl.elapsedNm * KM_PER_NM : direct, leftKm: 0 };
  }
  if (fl.offA === null) return { fraction: 0, doneKm: 0, leftKm: direct };

  let leftKm = havKm(pos.lat, pos.lon, fl.dst.lat, fl.dst.lon);
  let doneKm = 0;
  const last = fl.track.at(-1);
  if (fl.elapsedNm !== null && fl.remainingNm !== null) {
    const moved = last ? havKm(last.lat, last.lon, pos.lat, pos.lon) : 0;
    leftKm = Math.max(0, fl.remainingNm * KM_PER_NM - moved);
    doneKm = fl.elapsedNm * KM_PER_NM + moved;
  } else {
    fl.track.forEach((p, i) => {
      const prev = fl.track[i - 1];
      if (prev) doneKm += havKm(prev.lat, prev.lon, p.lat, p.lon);
    });
  }
  return { fraction: doneKm / Math.max(doneKm + leftKm, 1), doneKm, leftKm };
}
