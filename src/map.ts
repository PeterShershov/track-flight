// The route map. Each terminal cell is a braille character, so one cell holds 2 x 4 dots.

import { fg, mix, P, paint, RESET, type Rgb } from "./ansi.ts";
import { inAir, type Flight, type Position } from "./flight.ts";
import { gcPoints, land, sunElevation, sunState } from "./geo.ts";

type Pt = readonly [number, number];

// Braille dot bits, indexed by (x % 2) * 4 + (y % 4).
const BIT = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80];

export const ARROWS = "↑↗→↘↓↙←↖";
export const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Which of the 8 compass directions a bearing falls in. */
export function compassIndex(brg: number): number {
  return Math.floor((brg + 22.5) / 45) % 8;
}

/** A grid of braille cells. Coordinates are in dots. */
export class Dots {
  readonly w: number;
  readonly h: number;
  private readonly m: Uint8Array;
  private n = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.m = new Uint8Array(w * h);
  }

  /** The dot bits of one cell. */
  get(cx: number, cy: number): number {
    return this.m[cy * this.w + cx] ?? 0;
  }

  set(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.w * 2 || y >= this.h * 4) return;
    const i = (y >> 2) * this.w + (x >> 1);
    this.m[i] = (this.m[i] ?? 0) | (BIT[(x & 1) * 4 + (y & 3)] ?? 0);
  }

  /** Restart the dash pattern of dotted lines. */
  restartDashes(): void {
    this.n = 0;
  }

  /** Draw a line. With `every` above 1, only every nth dot is set, which makes it dotted. */
  line(p: Pt, q: Pt, every = 1): void {
    let [x0, y0] = [Math.round(p[0]), Math.round(p[1])];
    const [x1, y1] = [Math.round(q[0]), Math.round(q[1])];
    const w2 = this.w * 2;
    const h4 = this.h * 4;
    if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= w2 && x1 >= w2) || (y0 >= h4 && y1 >= h4)) return;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let steps = 0; steps < 20_000; steps++) {
      if (this.n % every === 0) this.set(x0, y0);
      this.n++;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  polyline(pts: readonly Pt[], { closed = false, every = 1 } = {}): void {
    pts.forEach((b, i) => {
      const a = pts[i - 1];
      if (a) this.line(a, b, every);
    });
    const first = pts[0];
    const last = pts.at(-1);
    if (closed && first && last && pts.length > 2) this.line(last, first, every);
  }

  /** Fill a polygon with a sparse dot pattern (about one dot in four). */
  stipple(pts: readonly Pt[]): void {
    const ys = pts.map((p) => p[1]);
    let y0 = Math.max(0, Math.ceil(Math.min(...ys)));
    const y1 = Math.min(this.h * 4 - 1, Math.floor(Math.max(...ys)));
    y0 += y0 & 1;
    for (let y = y0; y <= y1; y += 2) {
      const xs: number[] = [];
      pts.forEach((a, i) => {
        const b = pts.at(i - 1);
        if (b && ((a[1] <= y && y < b[1]) || (b[1] <= y && y < a[1]))) {
          xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      });
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] ?? 0));
        const to = Math.min(this.w * 2 - 1, Math.floor(xs[k + 1] ?? 0));
        for (let x = from; x <= to; x++) {
          if ((x + (y >> 1)) % 2 === 0) this.set(x, y);
        }
      }
    }
  }
}

/** Map projection: equirectangular, scaled so the whole route fits in the cells. */
export class View {
  readonly w: number;
  readonly h: number;
  readonly lon0: number;
  readonly lonc: number;
  readonly latc: number;
  readonly k: number;
  readonly kx: number;
  readonly key: string;

  constructor(fl: Flight, w: number, h: number) {
    this.w = w;
    this.h = h;
    this.lon0 = fl.org.lon;
    const pts: Pt[] = [
      [this.unwrap(fl.org.lon), fl.org.lat],
      [this.unwrap(fl.dst.lon), fl.dst.lat],
      ...fl.waypoints.map((p): Pt => [this.unwrap(p[0]), p[1]]),
      ...fl.track.map((p): Pt => [this.unwrap(p.lon), p.lat]),
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    this.lonc = (x0 + x1) / 2;
    this.latc = (y0 + y1) / 2;
    const dx = (x1 - x0) * 1.16 + 4;
    const dy = (y1 - y0) * 1.2 + 3;
    const cosLat = Math.max(0.2, Math.cos((this.latc * Math.PI) / 180));
    this.k = Math.min((2 * w) / (dx * cosLat), (4 * h) / dy);
    this.kx = this.k * cosLat;
    this.key = [w, h, this.lonc.toFixed(1), this.latc.toFixed(1), this.k.toFixed(2)].join("|");
  }

  /** Move a longitude by whole turns so it sits near the origin. Keeps routes over the date line in one piece. */
  unwrap(lon: number): number {
    return this.lon0 + ((((lon - this.lon0 + 180) % 360) + 360) % 360) - 180;
  }

  /** Dot position of a place. */
  xy(lon: number, lat: number): Pt {
    return [(this.unwrap(lon) - this.lonc) * this.kx + this.w, (this.latc - lat) * this.k + 2 * this.h];
  }

  /** The place at a dot position, as [lon, lat]. */
  lonlat(x: number, y: number): Pt {
    return [this.lonc + (x - this.w) / this.kx, this.latc - (y - 2 * this.h) / this.k];
  }
}

interface Layers {
  land: Dots;
  grid: Dots;
}

const layerCache = new Map<string, Layers>();

/** Coastlines and a faint 10-degree grid for a view. The coast never changes, so we keep it. */
function baseLayers(view: View): Layers {
  const cached = layerCache.get(view.key);
  if (cached) return cached;
  const layers: Layers = { land: new Dots(view.w, view.h), grid: new Dots(view.w, view.h) };
  const [lo0, la1] = view.lonlat(0, 0);
  const [lo1, la0] = view.lonlat(view.w * 2, view.h * 4);
  for (const ring of land()) {
    if (ring.maxY < la0 || ring.minY > la1) continue;
    for (const off of [-360, 0, 360]) {
      if (ring.maxX + off < lo0 || ring.minX + off > lo1) continue;
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < ring.pts.length; i += 2) {
        const lon = (ring.pts[i] ?? 0) / 10 + off;
        const lat = (ring.pts[i + 1] ?? 0) / 10;
        pts.push([(lon - view.lonc) * view.kx + view.w, (view.latc - lat) * view.k + 2 * view.h]);
      }
      layers.land.polyline(pts, { closed: true });
      layers.land.stipple(pts);
    }
  }
  for (let lon = Math.floor(lo0 / 10) * 10; lon <= lo1 + 10; lon += 10) {
    layers.grid.restartDashes();
    layers.grid.line(view.xy(lon, la0), view.xy(lon, la1), 4);
  }
  for (let lat = Math.floor(la0 / 10) * 10; lat <= la1 + 10; lat += 10) {
    layers.grid.restartDashes();
    layers.grid.line(view.xy(lo0, lat), view.xy(lo1, lat), 4);
  }
  if (layerCache.size > 4) layerCache.clear();
  layerCache.set(view.key, layers);
  return layers;
}

/** The map as w x h cells of text. Land is lit by the sun, so you can see where it is night. */
export function renderMap(fl: Flight, pos: Position, w: number, h: number, now: number): string[] {
  const view = new View(fl, w, h);
  const { land: coast, grid } = baseLayers(view);
  const planned = new Dots(w, h);
  const flown = new Dots(w, h);

  const route = fl.waypoints.length ? fl.waypoints : gcPoints(fl.org.lat, fl.org.lon, fl.dst.lat, fl.dst.lon);
  planned.polyline(
    route.map(([lon, lat]) => view.xy(lon, lat)),
    { every: 3 },
  );
  if (fl.offA !== null && fl.track.length) {
    const pts = [...fl.track.map((t) => view.xy(t.lon, t.lat)), view.xy(pos.lon, pos.lat)];
    flown.polyline(pts);
    flown.polyline(pts.map(([x, y]): Pt => [x, y + 1]));
  }

  // Airports and the plane sit on top of the dots, as whole characters.
  const over = new Map<number, string>();
  const put = (cx: number, cy: number, text: string) => {
    if (cx >= 0 && cx < w && cy >= 0 && cy < h) over.set(cy * w + cx, text);
  };
  for (const [a, color] of [
    [fl.org, P.org],
    [fl.dst, P.dst],
  ] as const) {
    const [x, y] = view.xy(a.lon, a.lat);
    const cx = Math.floor(x / 2);
    const cy = Math.floor(y / 4);
    const right = cx + 6 < w;
    [...(right ? `● ${a.code}` : `${a.code} ●`)].forEach((ch, i) =>
      put((right ? cx : cx - 4) + i, cy, ch === " " ? " " : paint(ch, color, true)),
    );
  }
  if (inAir(fl)) {
    const [x, y] = view.xy(pos.lon, pos.lat);
    put(
      Math.floor(x / 2),
      Math.floor(y / 4),
      paint(ARROWS.charAt(compassIndex(pos.brg)), Math.floor(now) % 2 ? P.txt : P.flown, true),
    );
  }

  const sun = sunState(Math.floor(now / 60) * 60);
  const rows: string[] = [];
  for (let cy = 0; cy < h; cy++) {
    let row = "";
    let last = "";
    for (let cx = 0; cx < w; cx++) {
      const special = over.get(cy * w + cx);
      if (special !== undefined) {
        row += RESET + special;
        last = "";
        continue;
      }
      const isLand = coast.get(cx, cy);
      const mask = isLand | grid.get(cx, cy) | planned.get(cx, cy) | flown.get(cx, cy);
      if (!mask) {
        row += " ";
        continue;
      }
      let color: Rgb;
      if (flown.get(cx, cy)) color = P.flown;
      else if (planned.get(cx, cy)) color = P.plan;
      else {
        const [lon, lat] = view.lonlat(cx * 2 + 1, cy * 4 + 2);
        const day = (sunElevation(Math.max(-90, Math.min(90, lat)), lon, sun) + 6) / 12;
        color = isLand ? mix(P.landNight, P.landDay, day) : mix(P.gratNight, P.gratDay, day);
      }
      const code = fg(color);
      if (code !== last) {
        row += code;
        last = code;
      }
      row += String.fromCharCode(0x2800 + mask);
    }
    rows.push(row + RESET);
  }
  return rows;
}
