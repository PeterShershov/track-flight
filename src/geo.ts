// Maps and sky: distances, bearings, the sun, and which land or sea a point is over.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { list } from "./json.ts";

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function havKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Compass bearing from point 1 to point 2, in degrees from north. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point km away from (lat, lon) along a bearing. Returns [lat, lon]. */
export function destination(lat: number, lon: number, brg: number, km: number): [number, number] {
  const d = km / R_KM;
  const b = rad(brg);
  const p1 = rad(lat);
  const l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** Points on the great circle between two places, as [lon, lat]. */
export function gcPoints(lat1: number, lon1: number, lat2: number, lon2: number, n = 64): [number, number][] {
  const p1 = rad(lat1);
  const l1 = rad(lon1);
  const p2 = rad(lat2);
  const l2 = rad(lon2);
  const d =
    2 *
    Math.asin(
      Math.min(1, Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)),
    );
  if (d === 0) return [[lon1, lat1]];
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return pts;
}

export interface Sun {
  /** Declination, in radians. */
  decl: number;
  /** Longitude where the sun is straight overhead, in degrees. */
  lon: number;
}

export function sunState(now: number): Sun {
  const dt = new Date(now * 1000);
  const minutes = dt.getUTCHours() * 60 + dt.getUTCMinutes() + dt.getUTCSeconds() / 60;
  const yday = Math.floor(
    (Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - Date.UTC(dt.getUTCFullYear(), 0, 1)) /
      86_400_000,
  );
  const g = ((2 * Math.PI) / 365) * (yday + (dt.getUTCHours() - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const eqt =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  return { decl, lon: -(minutes + eqt - 720) / 4 };
}

/** Height of the sun above the horizon at a place, in degrees. Negative means night. */
export function sunElevation(lat: number, lon: number, sun: Sun): number {
  const p = rad(lat);
  return deg(
    Math.asin(Math.sin(p) * Math.sin(sun.decl) + Math.cos(p) * Math.cos(sun.decl) * Math.cos(rad(lon - sun.lon))),
  );
}

// ---------------------------------------------------------------------------------------------- land

/** One coast line. `pts` holds lon, lat, lon, lat... in tenths of a degree. */
export interface Ring {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pts: number[];
}

function isNumbers(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number");
}

let landCache: Ring[] | undefined;

/** The world's land, from land.json (Natural Earth 1:50m, simplified). Empty when the file is missing. */
export function land(): Ring[] {
  if (landCache) return landCache;
  landCache = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "land.json"), "utf8"));
    for (const pts of list(raw)) {
      if (!isNumbers(pts) || pts.length < 6) continue;
      const xs = pts.filter((_, i) => i % 2 === 0);
      const ys = pts.filter((_, i) => i % 2 === 1);
      landCache.push({
        minX: Math.min(...xs) / 10,
        minY: Math.min(...ys) / 10,
        maxX: Math.max(...xs) / 10,
        maxY: Math.max(...ys) / 10,
        pts,
      });
    }
  } catch {
    // No map file. The dashboard still works without coastlines.
  }
  return landCache;
}

/** True when the point is on land. */
export function overLand(lat: number, lon: number): boolean {
  let inside = false;
  for (const ring of land()) {
    if (lon < ring.minX || lon > ring.maxX || lat < ring.minY || lat > ring.maxY) continue;
    const px = lon * 10;
    const py = lat * 10;
    const { pts } = ring;
    const n = pts.length / 2;
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[2 * i] ?? 0;
      const yi = pts[2 * i + 1] ?? 0;
      const xj = pts[2 * j] ?? 0;
      const yj = pts[2 * j + 1] ?? 0;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    inside = inside || c;
  }
  return inside;
}

// [lat from, lat to, lon from, lon to, name]. The first box that matches wins.
const OCEANS: readonly (readonly [number, number, number, number, string])[] = [
  [30, 46, -6, 36, "Mediterranean Sea"],
  [41, 47, 28, 42, "Black Sea"],
  [51, 62, -4, 9, "North Sea"],
  [18, 31, -98, -81, "Gulf of Mexico"],
  [9, 22, -87, -60, "Caribbean Sea"],
  [5, 26, 50, 78, "Arabian Sea"],
  [70, 90, -180, 180, "Arctic Ocean"],
  [-90, -60, -180, 180, "Southern Ocean"],
  [0, 70, -100, 0, "North Atlantic Ocean"],
  [-60, 0, -70, 20, "South Atlantic Ocean"],
  [-60, 30, 20, 120, "Indian Ocean"],
  [0, 70, 120, 180, "North Pacific Ocean"],
  [0, 70, -180, -100, "North Pacific Ocean"],
  [-60, 0, 120, 180, "South Pacific Ocean"],
  [-60, 0, -180, -70, "South Pacific Ocean"],
];

export function oceanName(lat: number, lon: number): string {
  for (const [la0, la1, lo0, lo1, name] of OCEANS) {
    if (lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1) return name;
  }
  return "Open water";
}
