#!/usr/bin/env python3
"""
flight-tui - a live, full-screen flight tracker for your terminal.

Usage:
  ./flight-tui.py [options] FLIGHT          for example: ./flight-tui.py UA125

Options:
  -d, --date YYYY-MM-DD   Follow the flight that departs on this date (local time at the origin).
  -i, --interval SECONDS  Seconds between data checks. Default 60. Minimum 30.
  --pos-every MINUTES     Send a position notification this often in the air. Default 30. 0 = off.
  --no-notify             Do not send macOS notifications.
  --once                  Print one frame and exit (no full-screen mode).
  --size WxH              Frame size for --once, for example 110x34.
  --json FILE             Test aid: read the flight from a saved FlightAware JSON file.
  --now EPOCH             Test aid: pretend this is the current time.

Keys:  q quit   r refresh now   n notifications on/off

The map uses braille dots. Land is lit by the real sun, so you can see night fall on the route.
Flight data comes from the public FlightAware flight page (not an official API).
Needs Python 3.9 or newer. No packages to install.
"""
import argparse
import json
import math
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import termios
import threading
import time
import tty
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from functools import lru_cache
from types import SimpleNamespace as S
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.realpath(__file__))
FA = "https://www.flightaware.com"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
SCRIPT_UA = "flight-tui/1.0 (personal flight tracker)"
KM_PER_NM = 1.852
SHIFT_MIN = 10          # Notify when an estimate moves this many minutes or more.


# --------------------------------------------------------------------------- colors

class P:
    acc = (88, 196, 255)
    flown = (255, 184, 64)
    plan = (96, 150, 200)
    ok = (96, 222, 150)
    warn = (255, 184, 64)
    bad = (255, 104, 110)
    txt = (226, 231, 238)
    dim = (122, 131, 145)
    line = (66, 76, 92)
    land_day = (104, 168, 132)
    land_night = (40, 66, 74)
    grat_day = (58, 68, 84)
    grat_night = (32, 38, 52)
    org = (130, 232, 176)
    dst = (255, 142, 164)


TRUECOLOR = (os.environ.get("COLORTERM", "").lower() in ("truecolor", "24bit")
             or os.environ.get("TERM_PROGRAM") in ("iTerm.app", "vscode", "WezTerm", "ghostty"))
RESET = "\x1b[0m"
BOLD = "\x1b[1m"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _to256(r, g, b):
    if abs(r - g) < 10 and abs(g - b) < 10:
        gray = round((r - 8) / 10)
        return 16 if gray < 0 else 231 if gray > 23 else 232 + gray
    return 16 + 36 * round(r / 255 * 5) + 6 * round(g / 255 * 5) + round(b / 255 * 5)


@lru_cache(maxsize=None)
def fg(c):
    r, g, b = (int(v) for v in c)
    return f"\x1b[38;2;{r};{g};{b}m" if TRUECOLOR else f"\x1b[38;5;{_to256(r, g, b)}m"


@lru_cache(maxsize=None)
def bg(c):
    r, g, b = (int(v) for v in c)
    return f"\x1b[48;2;{r};{g};{b}m" if TRUECOLOR else f"\x1b[48;5;{_to256(r, g, b)}m"


def paint(text, c=None, bold=False):
    pre = (BOLD if bold else "") + (fg(c) if c else "")
    return f"{pre}{text}{RESET}" if pre else text


def pill(text, c):
    return f"{bg(c)}{fg((14, 18, 24))}{BOLD} {text} {RESET}"


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def vlen(s):
    return len(ANSI.sub("", s))


def clip(s, w):
    out, n, i = [], 0, 0
    while i < len(s) and n < w:
        m = ANSI.match(s, i)
        if m:
            out.append(m.group())
            i = m.end()
        else:
            out.append(s[i])
            n += 1
            i += 1
    return "".join(out) + RESET


def fit(s, w):
    n = vlen(s)
    return clip(s, w) + " " * (w - min(n, w)) if n >= w else s + " " * (w - n)


def right_align(left, right, w):
    gap = w - vlen(left) - vlen(right)
    return left + " " * max(gap, 1) + right if gap >= 1 else clip(left, w)


def box(lines, w, h, title="", right="", pad=1):
    bc = fg(P.line)
    t = f" {title} " if title else ""
    r = f" {right} " if right else ""
    top = (f"{bc}╭─{RESET}{t}{bc}{'─' * max(w - 4 - vlen(t) - vlen(r), 0)}{RESET}{r}{bc}─╮{RESET}")
    out = [fit(top, w)]
    for i in range(h - 2):
        body = lines[i] if i < len(lines) else ""
        out.append(f"{bc}│{RESET}{' ' * pad}{fit(body, w - 2 - 2 * pad)}{' ' * pad}{bc}│{RESET}")
    out.append(f"{bc}╰{'─' * (w - 2)}╯{RESET}")
    return out


def hjoin(cols, gap=1):
    return [(" " * gap).join(row) for row in zip(*cols)]


# --------------------------------------------------------------------------- geo

R_KM = 6371.0088


def hav_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * R_KM * math.asin(min(1, math.sqrt(a)))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(lat, lon, brg, km):
    d, b = km / R_KM, math.radians(brg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def gc_points(lat1, lon1, lat2, lon2, n=64):
    """Points on the great circle between two places, as (lon, lat)."""
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = 2 * math.asin(min(1, math.sqrt(math.sin((p2 - p1) / 2) ** 2
                                       + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2)))
    if d == 0:
        return [(lon1, lat1)]
    pts = []
    for i in range(n + 1):
        f = i / n
        a, b = math.sin((1 - f) * d) / math.sin(d), math.sin(f * d) / math.sin(d)
        x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
        y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
        z = a * math.sin(p1) + b * math.sin(p2)
        pts.append((math.degrees(math.atan2(y, x)), math.degrees(math.atan2(z, math.hypot(x, y)))))
    return pts


def sun_state(now):
    """(declination in radians, longitude of the sub-solar point in degrees)."""
    dt = datetime.fromtimestamp(now, timezone.utc)
    minutes = dt.hour * 60 + dt.minute + dt.second / 60
    g = 2 * math.pi / 365 * (dt.timetuple().tm_yday - 1 + (dt.hour - 12) / 24)
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                    - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    return decl, -(minutes + eqt - 720) / 4


def sun_elevation(lat, lon, sun):
    decl, sublon = sun
    p = math.radians(lat)
    return math.degrees(math.asin(math.sin(p) * math.sin(decl)
                                  + math.cos(p) * math.cos(decl) * math.cos(math.radians(lon - sublon))))


def _load_land():
    try:
        with open(os.path.join(HERE, "land.json")) as f:
            rings = json.load(f)
    except (OSError, ValueError):
        return []
    out = []
    for flat in rings:
        xs, ys = flat[0::2], flat[1::2]
        out.append((min(xs) / 10, min(ys) / 10, max(xs) / 10, max(ys) / 10, flat))
    return out


LAND = _load_land()


def over_land(lat, lon):
    inside = False
    for x0, y0, x1, y1, flat in LAND:
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        px, py, n, c = lon * 10, lat * 10, len(flat) // 2, False
        j = n - 1
        for i in range(n):
            xi, yi, xj, yj = flat[2 * i], flat[2 * i + 1], flat[2 * j], flat[2 * j + 1]
            if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
                c = not c
            j = i
        inside = inside or c
    return inside


OCEANS = [  # (lat0, lat1, lon0, lon1, name); the first box that matches wins.
    (30, 46, -6, 36, "Mediterranean Sea"), (41, 47, 28, 42, "Black Sea"), (51, 62, -4, 9, "North Sea"),
    (18, 31, -98, -81, "Gulf of Mexico"), (9, 22, -87, -60, "Caribbean Sea"),
    (5, 26, 50, 78, "Arabian Sea"), (70, 90, -180, 180, "Arctic Ocean"),
    (-90, -60, -180, 180, "Southern Ocean"),
    (0, 70, -100, 0, "North Atlantic Ocean"), (-60, 0, -70, 20, "South Atlantic Ocean"),
    (-60, 30, 20, 120, "Indian Ocean"),
    (0, 70, 120, 180, "North Pacific Ocean"), (0, 70, -180, -100, "North Pacific Ocean"),
    (-60, 0, 120, 180, "South Pacific Ocean"), (-60, 0, -180, -70, "South Pacific Ocean"),
]


def ocean_name(lat, lon):
    for la0, la1, lo0, lo1, name in OCEANS:
        if la0 <= lat <= la1 and lo0 <= lon <= lo1:
            return name
    return "Open water"


# --------------------------------------------------------------------------- data

def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fa_page(path):
    marker = "var trackpollBootstrap = "
    html = http_get(FA + path)
    i = html.find(marker)
    if i < 0:
        raise RuntimeError("FlightAware sent a page without flight data")
    return json.JSONDecoder().raw_decode(html, i + len(marker))[0]


def first_flight(boot):
    for v in (boot.get("flights") or {}).values():
        return v
    return None


def resolve_ident(query):
    q = re.sub(r"\s+", "", query).upper()
    try:
        url = f"{FA}/ajax/ignoreall/omnisearch/flight.rvt?v=50&locale=en_US&searchterm={q}&q={q}"
        data = json.loads(http_get(url, 20))["data"]
        return ([d for d in data if d.get("major_airline") == "1"] or data)[0]["ident"]
    except Exception:
        return q


def tzinfo(name):
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def pick_link(flight, date):
    if not date:
        return (flight.get("links") or {}).get("permanent")
    for fl in (flight.get("activityLog") or {}).get("flights") or []:
        tz = ((fl.get("origin") or {}).get("TZ") or ":UTC").lstrip(":")
        ts = ((fl.get("gateDepartureTimes") or {}).get("scheduled")
              or (fl.get("takeoffTimes") or {}).get("scheduled"))
        if ts and datetime.fromtimestamp(ts, tzinfo(tz)).strftime("%Y-%m-%d") == date:
            return fl.get("permaLink")
    return None


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def airport(a):
    a = a or {}
    c = a.get("coord") or [0, 0]
    gate, term = a.get("gate") or "", a.get("terminal") or ""
    m = re.fullmatch(r"([A-Z])HOLD", gate)      # FlightAware: "BHOLD" means "terminal B, no gate yet".
    if m:
        gate, term = "", term or m.group(1)
    return S(code=a.get("iata") or a.get("icao") or "???", city=a.get("friendlyLocation") or a.get("friendlyName") or "",
             lon=c[0], lat=c[1], tz=(a.get("TZ") or ":UTC").lstrip(":"), gate=gate, term=term)


def model(f):
    def tm(key):
        d = f.get(key) or {}
        return num(d.get("scheduled")), num(d.get("estimated")), num(d.get("actual"))

    dep_s, dep_e, dep_a = tm("gateDepartureTimes")
    _, _, off_a = tm("takeoffTimes")
    on_s, on_e, on_a = tm("landingTimes")
    arr_s, arr_e, arr_a = tm("gateArrivalTimes")
    track = []
    for p in f.get("track") or []:
        c = p.get("coord")
        if c and num(p.get("timestamp")) is not None:
            track.append((p["timestamp"], c[0], c[1], num(p.get("alt")), num(p.get("gs"))))
    dist = f.get("distance") or {}
    return S(
        name=f.get("friendlyIdent") or f.get("displayIdent") or "Flight",
        aircraft=re.sub(r"\s*\(.*\)$", "", (f.get("aircraft") or {}).get("friendlyType") or "").title(),
        org=airport(f.get("origin")), dst=airport(f.get("destination")),
        dep_s=dep_s, dep_e=dep_e, dep_a=dep_a, off_a=off_a,
        on_s=on_s, on_e=on_e, on_a=on_a, arr_s=arr_s, arr_e=arr_e, arr_a=arr_a,
        cancelled=bool(f.get("cancelled")), diverted=bool(f.get("diverted")),
        track=track, waypoints=[(w[0], w[1]) for w in f.get("waypoints") or [] if len(w) >= 2],
        alt=num(f.get("altitude")), gs=num(f.get("groundspeed")), hdg=num(f.get("heading")),
        elapsed_nm=num(dist.get("elapsed")), remaining_nm=num(dist.get("remaining")),
        stamp=num(f.get("timestamp")), fetched=time.time(), place="")


def phase(fl, now):
    if fl.cancelled:
        return "CANCELLED", P.bad
    if fl.diverted:
        return "DIVERTED", P.bad
    if fl.arr_a:
        return "ARRIVED", P.ok
    if fl.on_a:
        return "TAXIING IN", P.ok
    if fl.off_a:
        return "AIRBORNE", P.acc
    if fl.dep_a:
        return "TAXIING OUT", P.warn
    if fl.dep_s and (fl.dep_e or fl.dep_s) - fl.dep_s >= 900:
        return "DELAYED", P.warn
    return "SCHEDULED", P.dim


def delta_minutes(a, b):
    return None if a is None or b is None else round((a - b) / 60)


def delta_text(mins):
    """(text, color) for a time against its schedule."""
    if mins is None:
        return "", P.dim
    if abs(mins) < 5:
        return "on time", P.ok
    if mins < 0:
        return f"{-mins} min early", P.ok
    return f"{mins} min late", (P.bad if mins >= 30 else P.warn)


def position(fl, now):
    """Best guess of where the plane is now: (lat, lon, bearing, estimated)."""
    o, d = fl.org, fl.dst
    if fl.arr_a or fl.on_a:
        return S(lat=d.lat, lon=d.lon, brg=bearing(o.lat, o.lon, d.lat, d.lon), est=False)
    if not fl.off_a or not fl.track:
        return S(lat=o.lat, lon=o.lon, brg=bearing(o.lat, o.lon, d.lat, d.lon), est=False)
    ts, lon, lat, _, gs = fl.track[-1]
    brg = fl.hdg if fl.hdg is not None else bearing(lat, lon, d.lat, d.lon)
    for p in reversed(fl.track[-30:-1]):
        if hav_km(p[2], p[1], lat, lon) >= 1:
            brg = bearing(p[2], p[1], lat, lon)
            break
    speed = gs or fl.gs
    age = max(0, min(now - ts, 1200))
    if speed and age:
        km = speed * KM_PER_NM * age / 3600
        if km < hav_km(lat, lon, d.lat, d.lon):
            lat, lon = destination(lat, lon, brg, km)
        else:
            lat, lon = d.lat, d.lon
    return S(lat=lat, lon=lon, brg=brg, est=True)


def progress(fl, pos, now):
    """(fraction done, km flown, km to go)."""
    if fl.arr_a or fl.on_a:
        total = fl.elapsed_nm * KM_PER_NM if fl.elapsed_nm else hav_km(fl.org.lat, fl.org.lon, fl.dst.lat, fl.dst.lon)
        return 1.0, total, 0.0
    if not fl.off_a:
        total = hav_km(fl.org.lat, fl.org.lon, fl.dst.lat, fl.dst.lon)
        return 0.0, 0.0, total
    rem = hav_km(pos.lat, pos.lon, fl.dst.lat, fl.dst.lon)
    done = None
    if fl.elapsed_nm is not None and fl.remaining_nm is not None:
        rem_fa, done = fl.remaining_nm * KM_PER_NM, fl.elapsed_nm * KM_PER_NM
        moved = hav_km(fl.track[-1][2], fl.track[-1][1], pos.lat, pos.lon) if fl.track else 0
        rem, done = max(0.0, rem_fa - moved), done + moved
    if done is None:
        pts = fl.track
        done = sum(hav_km(a[2], a[1], b[2], b[1]) for a, b in zip(pts, pts[1:]))
    return done / max(done + rem, 1), done, rem


# --------------------------------------------------------------------------- map

BIT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]]


class Dots:
    """A grid of braille cells. Each cell holds 2 x 4 dots."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.m = [[0] * w for _ in range(h)]
        self.n = 0

    def set(self, x, y):
        if 0 <= x < self.w * 2 and 0 <= y < self.h * 4:
            self.m[y >> 2][x >> 1] |= BIT[x & 1][y & 3]

    def line(self, p, q, every=1):
        x0, y0, x1, y1 = (int(round(v)) for v in (p[0], p[1], q[0], q[1]))
        w2, h4 = self.w * 2, self.h * 4
        if (x0 < 0 and x1 < 0) or (y0 < 0 and y1 < 0) or (x0 >= w2 and x1 >= w2) or (y0 >= h4 and y1 >= h4):
            return
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err, steps = dx + dy, 0
        while steps < 20000:
            if self.n % every == 0:
                self.set(x0, y0)
            self.n += 1
            steps += 1
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def polyline(self, pts, closed=False, every=1):
        for a, b in zip(pts, pts[1:]):
            self.line(a, b, every)
        if closed and len(pts) > 2:
            self.line(pts[-1], pts[0], every)

    def stipple(self, pts):
        """Fill a polygon with a sparse dot pattern."""
        ys = [p[1] for p in pts]
        y0, y1 = max(0, math.ceil(min(ys))), min(self.h * 4 - 1, int(max(ys)))
        y0 += y0 & 1
        n = len(pts)
        for y in range(y0, y1 + 1, 2):
            xs = []
            for i in range(n):
                ax, ay = pts[i]
                bx, by = pts[i - 1]
                if (ay <= y < by) or (by <= y < ay):
                    xs.append(ax + (y - ay) * (bx - ax) / (by - ay))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                for x in range(max(0, math.ceil(xs[k])), min(self.w * 2 - 1, int(xs[k + 1])) + 1):
                    if (x + y // 2) % 2 == 0:
                        self.set(x, y)


class View:
    """Map projection: equirectangular, scaled so the whole route fits in the cells."""

    def __init__(self, fl, w, h):
        self.w, self.h, self.lon0 = w, h, fl.org.lon
        pts = [(self.unwrap(fl.org.lon), fl.org.lat), (self.unwrap(fl.dst.lon), fl.dst.lat)]
        pts += [(self.unwrap(a), b) for a, b in fl.waypoints]
        pts += [(self.unwrap(t[1]), t[2]) for t in fl.track]
        x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
        y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
        self.lonc, self.latc = (x0 + x1) / 2, (y0 + y1) / 2
        dx, dy = (x1 - x0) * 1.16 + 4, (y1 - y0) * 1.2 + 3
        cosl = max(0.2, math.cos(math.radians(self.latc)))
        self.k = min(2 * w / (dx * cosl), 4 * h / dy)
        self.kx = self.k * cosl
        self.key = (w, h, round(self.lonc, 1), round(self.latc, 1), round(self.k, 2))

    def unwrap(self, lon):
        return self.lon0 + ((lon - self.lon0 + 180) % 360 - 180)

    def xy(self, lon, lat):
        return (self.unwrap(lon) - self.lonc) * self.kx + self.w, (self.latc - lat) * self.k + 2 * self.h

    def lonlat(self, x, y):
        return self.lonc + (x - self.w) / self.kx, self.latc - (y - 2 * self.h) / self.k


_land_cache = {}


def land_layer(view):
    """(land dots, graticule dots) for this view. Cached, because the coastline never changes."""
    if view.key in _land_cache:
        return _land_cache[view.key]
    d, grid = Dots(view.w, view.h), Dots(view.w, view.h)
    lo0, la1 = view.lonlat(0, 0)
    lo1, la0 = view.lonlat(view.w * 2, view.h * 4)
    for x0, y0, x1, y1, flat in LAND:
        if y1 < la0 or y0 > la1:
            continue
        for off in (-360, 0, 360):
            if x1 + off < lo0 or x0 + off > lo1:
                continue
            pts = [((flat[i] / 10 + off - view.lonc) * view.kx + view.w, (view.latc - flat[i + 1] / 10) * view.k + 2 * view.h)
                   for i in range(0, len(flat), 2)]
            d.polyline(pts, closed=True)
            d.stipple(pts)
    # A faint graticule every 10 degrees, dotted.
    for lon in range(int(lo0 // 10) * 10, int(lo1) + 11, 10):
        grid.n = 0
        grid.line(view.xy(lon, la0), view.xy(lon, la1), every=4)
    for lat in range(int(la0 // 10) * 10, int(la1) + 11, 10):
        grid.n = 0
        grid.line(view.xy(lo0, lat), view.xy(lo1, lat), every=4)
    if len(_land_cache) > 4:
        _land_cache.clear()
    _land_cache[view.key] = (d, grid)
    return d, grid


ARROWS = "↑↗→↘↓↙←↖"
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def render_map(fl, pos, w, h, now):
    view = View(fl, w, h)
    land, grid = land_layer(view)
    planned, flown = Dots(w, h), Dots(w, h)

    if fl.waypoints:
        planned.polyline([view.xy(a, b) for a, b in fl.waypoints], every=3)
    else:
        planned.polyline([view.xy(a, b) for a, b in gc_points(fl.org.lat, fl.org.lon, fl.dst.lat, fl.dst.lon)], every=3)
    if fl.off_a and fl.track:
        pts = [view.xy(t[1], t[2]) for t in fl.track] + [view.xy(pos.lon, pos.lat)]
        flown.polyline(pts)
        flown.polyline([(x, y + 1) for x, y in pts])

    # Land is lit by the real sun. Recompute once a minute.
    sun = sun_state(now // 60 * 60)
    over = {}
    for code, a, c in ((fl.org.code, fl.org, P.org), (fl.dst.code, fl.dst, P.dst)):
        x, y = view.xy(a.lon, a.lat)
        cx, cy = int(x // 2), int(y // 4)
        label = f"● {code}" if cx + 6 < w else f"{code} ●"
        x0 = cx if cx + 6 < w else cx - 4
        for i, ch in enumerate(label):
            over[(x0 + i, cy)] = paint(ch, c, bold=True) if i < 1 or ch != " " else " "
    px, py = view.xy(pos.lon, pos.lat)
    pcx, pcy = int(px // 2), int(py // 4)
    arrow = ARROWS[int((pos.brg + 22.5) // 45) % 8]
    if fl.off_a and not fl.on_a:
        over[(pcx, pcy)] = paint(arrow, P.txt if int(now) % 2 else P.flown, bold=True)

    rows = []
    for cy in range(h):
        row, last = [], None
        for cx in range(w):
            if (cx, cy) in over:
                row.append(RESET + over[(cx, cy)])
                last = None
                continue
            mask = land.m[cy][cx] | grid.m[cy][cx] | planned.m[cy][cx] | flown.m[cy][cx]
            if not mask:
                row.append(" ")
                continue
            if flown.m[cy][cx]:
                col = P.flown
            elif planned.m[cy][cx]:
                col = P.plan
            else:
                lon, lat = view.lonlat(cx * 2 + 1, cy * 4 + 2)
                day = (sun_elevation(max(-90, min(90, lat)), lon, sun) + 6) / 12
                dark, lit = (P.land_night, P.land_day) if land.m[cy][cx] else (P.grat_night, P.grat_day)
                col = tuple(int(v) for v in mix(dark, lit, day))
            if col != last:
                row.append(fg(col))
                last = col
            row.append(chr(0x2800 + mask))
        rows.append("".join(row) + RESET)
    return rows


# --------------------------------------------------------------------------- panels

SPARK = "▁▂▃▄▅▆▇█"


def spark(vals, width, hi=None):
    if not vals:
        return paint("no data yet", P.dim)
    n, out = len(vals), []
    hi = hi or max(vals) or 1
    for i in range(width):
        a = int(i * n / width)
        seg = vals[a:max(a + 1, int((i + 1) * n / width))]
        v = sum(seg) / len(seg)
        lvl = max(0, min(7, int(v / hi * 7.999)))
        out.append(paint(SPARK[lvl], mix((64, 104, 156), P.acc, lvl / 7)))
    return "".join(out)


def fmt_int(n):
    return f"{int(round(n)):,}"


def tz_clock(ep, tzname, now, abbr=True):
    if ep is None:
        return "—"
    z = tzinfo(tzname)
    dt = datetime.fromtimestamp(ep, z)
    s = dt.strftime("%H:%M")
    if dt.date() != datetime.fromtimestamp(now, z).date():
        s = dt.strftime("%a ") + s
    return f"{s} {dt.strftime('%Z')}" if abbr else s


def fmt_dur(sec):
    sec = max(0, int(sec))
    h, m = sec // 3600, sec % 3600 // 60
    return f"{h}h {m:02d}m" if h else f"{m} min" if m else "<1 min"


def gauges(fl, pos, now, w, h):
    iw = w - 4
    air = fl.off_a and not fl.on_a
    hist_alt = [t[3] for t in fl.track if t[3] is not None]
    hist_gs = [t[4] for t in fl.track if t[4] is not None]
    lab = lambda s: paint(s, P.dim)

    alt = paint("On the ground", P.dim) if not air or fl.alt is None else (
        paint(f"{fmt_int(round(fl.alt * 30.48, -1))} m", P.txt, bold=True) + paint(f"   FL{int(fl.alt):03d}", P.dim))
    gs = paint("—", P.dim) if not air or fl.gs is None else (
        paint(f"{fmt_int(fl.gs * KM_PER_NM)} km/h", P.txt, bold=True))
    d = int((pos.brg + 22.5) // 45) % 8
    hdg = paint(f"{round(pos.brg):03d}°", P.txt, bold=True) + paint(f"  {COMPASS[d]}  ", P.dim) + paint(ARROWS[d], P.flown, bold=True)
    if not air:
        hdg = paint("—", P.dim)
    lat_s = f"{abs(pos.lat):.2f}°{'N' if pos.lat >= 0 else 'S'}"
    lon_s = f"{abs(pos.lon):.2f}°{'E' if pos.lon >= 0 else 'W'}"
    elev = sun_elevation(pos.lat, pos.lon, sun_state(now))
    sun = paint("☀ Daylight", P.flown) if elev > 0 else paint("☾ Night", P.acc)
    if -6 < elev <= 0:
        sun = paint("☾ Twilight", P.acc)
    place = fl.place or ocean_name(pos.lat, pos.lon)

    sections = [
        [lab("ALTITUDE"), alt, spark(hist_alt, iw, hi=max(hist_alt + [400]))],
        [lab("GROUND SPEED"), gs, spark(hist_gs, iw, hi=max(hist_gs + [500]))],
        [lab("HEADING"), hdg],
        [lab("POSITION"), paint(f"{lat_s}  {lon_s}", P.txt, bold=True), paint(place, P.dim)],
        [lab("SUN AT PLANE"), sun],
        [lab("AIRCRAFT"), paint(fl.aircraft or "—", P.txt)],
    ]
    ih = h - 2
    for sep in (1, 0):
        secs = list(sections)
        while len(secs) > 1 and sum(len(s) for s in secs) + sep * (len(secs) - 1) > ih:
            secs.pop()
        if sum(len(s) for s in secs) + sep * (len(secs) - 1) <= ih:
            break
    lines = []
    for s in secs:
        lines += s + ([""] if sep else [])
    return box(lines, w, h, title=paint("COCKPIT", P.acc, bold=True))


def time_row(label, value, note="", note_color=P.dim, extra="", width=999):
    """One 'label  value  note  extra' line. The extra part goes first when the line is too long."""
    row = paint(f"{label:<10}", P.dim) + value + ("  " + paint(note, note_color) if note else "")
    full = row + ("  " + paint(extra, P.dim) if extra else "")
    return full if vlen(full) <= width else row


def airport_box(fl, a, now, w, h, departure):
    z = a.tz
    gate = " · ".join(x for x in (f"Terminal {a.term}" if a.term else "", f"Gate {a.gate}" if a.gate else "") if x)
    head = paint(gate or "Gate not assigned yet", P.txt if gate else P.dim, bold=bool(gate))
    clock = lambda ep: paint(tz_clock(ep, z, now), P.txt, bold=True)
    local = datetime.fromtimestamp(now, tzinfo(z))
    iw = w - 4
    now_row = time_row("Local", paint(local.strftime("%H:%M %Z"), P.txt, bold=True), local.strftime("%a %-d %b"))
    if departure:
        sched, best = fl.dep_s, fl.dep_a or fl.dep_e
        note, nc = delta_text(delta_minutes(best, sched))
        rows = [head,
                time_row("Left gate", clock(best) if best else paint("—", P.dim), note, nc,
                         f"sched {tz_clock(sched, z, now, False)}" if sched else "", iw),
                time_row("Took off", clock(fl.off_a) if fl.off_a else paint("—", P.dim)),
                now_row]
        title = f"DEPARTURE · {a.code}"
    else:
        sched, best = fl.arr_s, fl.arr_a or fl.arr_e
        note, nc = delta_text(delta_minutes(best, sched))
        land = fl.on_a or fl.on_e
        rows = [head,
                time_row("Landing", clock(land) if land else paint("—", P.dim), "" if fl.on_a else "estimated", P.dim),
                time_row("At gate", clock(best) if best else paint("—", P.dim), note, nc,
                         f"sched {tz_clock(sched, z, now, False)}" if sched else "", iw),
                now_row]
        title = f"ARRIVAL · {a.code}"
    return box(rows, w, h, title=paint(title, P.org if departure else P.dst, bold=True),
               right=paint(a.city, P.dim))


def header(fl, pos, now, w):
    label, color = phase(fl, now)
    beat = "●" if int(now) % 2 else "○"
    st = pill(f"{beat} {label}", color)
    tag = ""
    if label in ("AIRBORNE", "TAXIING IN", "ARRIVED", "TAXIING OUT"):
        text, tc = delta_text(delta_minutes(fl.arr_a or fl.arr_e, fl.arr_s))
    else:
        text, tc = delta_text(delta_minutes(fl.dep_a or fl.dep_e, fl.dep_s))
    if text:
        tag = pill(text.upper(), tc) + " "
    l1 = " " + paint("✈", P.flown, bold=True) + " " + paint(fl.name.upper(), P.txt, bold=True) + paint(
        f"   {fl.aircraft}" if fl.aircraft else "", P.dim)
    z = tzinfo(fl.org.tz)
    dep_day = datetime.fromtimestamp(fl.dep_s or fl.dep_e or time.time(), z).strftime("%a %-d %b %Y")
    l2 = (" " + paint(fl.org.code, P.org, bold=True) + paint(f" {fl.org.city}", P.txt) + paint("   ───►   ", P.dim)
          + paint(fl.dst.code, P.dst, bold=True) + paint(f" {fl.dst.city}", P.txt))
    return [right_align(l1, tag + st + " ", w), right_align(l2, paint(dep_day + " ", P.dim), w),
            paint("─" * w, P.line)]


def progress_lines(fl, pos, now, w, wide):
    frac, done, rem = progress(fl, pos, now)
    left, right = paint(f" {fl.org.code} ", P.org, bold=True), paint(f" {fl.dst.code} ", P.dst, bold=True)
    pct = paint(f"{int(frac * 100):>3d}% ", P.txt, bold=True)
    bw = max(10, w - vlen(left) - vlen(right) - vlen(pct))
    at = min(bw - 1, int(frac * (bw - 1)))
    bar = []
    for i in range(bw):
        if i == at and 0 < frac:
            bar.append(paint("✈", P.txt, bold=True))
        elif i < at:
            bar.append(paint("━", mix(P.acc, P.flown, i / max(bw - 1, 1))))
        else:
            bar.append(paint("╌", P.line))
    l1 = left + "".join(bar) + right + pct

    sep = paint("  ·  ", P.line)
    val = lambda s: paint(s, P.txt, bold=True)
    parts = []
    air = fl.off_a and not fl.on_a
    if wide:
        parts += [val(fmt_int(done)) + paint(" km flown", P.dim), val(fmt_int(rem)) + paint(" km to go", P.dim)]
    elif air and fl.alt is not None and fl.gs is not None:
        parts += [val(f"{fmt_int(round(fl.alt * 30.48, -1))} m"), val(f"{fmt_int(fl.gs * KM_PER_NM)} km/h"),
                  val(f"{fmt_int(rem)} km") + paint(" to go", P.dim)]
    else:
        parts += [val(fmt_int(rem)) + paint(" km to go", P.dim)]
    land = fl.on_a or fl.on_e or fl.on_s
    if fl.cancelled:
        parts.append(paint("cancelled", P.bad, bold=True))
    elif fl.arr_a or fl.on_a:
        parts.append(paint("landed ", P.dim) + val(fmt_dur(now - (fl.on_a or fl.arr_a)) + " ago"))
    elif air and land:
        parts.append(paint("landing in ", P.dim) + val(fmt_dur(land - now)) if land > now else paint("landing any moment", P.dim))
    elif fl.dep_a:
        parts.append(paint("taxiing to the runway", P.dim))
    elif fl.dep_e or fl.dep_s:
        t = fl.dep_e or fl.dep_s
        parts.append(paint("departs in ", P.dim) + val(fmt_dur(t - now)) if t > now else paint("departure due", P.warn))
    if wide and not (fl.arr_a or fl.on_a) and (fl.arr_e or fl.arr_s):
        parts.append(paint("arrives ", P.dim) + val(tz_clock(fl.arr_e or fl.arr_s, fl.dst.tz, now)))
    l2 = sep.join(parts)
    pad = max(0, (w - vlen(l2)) // 2)
    return [l1, " " * pad + l2]


def retry_text(app, now):
    left = int(app.retry_at - now)
    if not app.retry_at or left < 0:
        return "retrying"
    return f"retrying in {left}s" if left < 60 else f"retrying in {fmt_dur(left)}"


def footer(app, w, now):
    keys = "  ".join(paint(k, P.txt, bold=True) + paint(f" {v}", P.dim) for k, v in
                     (("q", "quit"), ("r", "refresh"), ("n", "notifications " + ("on" if app.notify_on else "off"))))
    if app.err:
        status = paint("● offline", P.bad, bold=True) + paint(f" · {app.err[:55]} · {retry_text(app, now)}", P.dim)
    else:
        age = max(0, now - app.checked) if app.checked else 0
        fresh = age < app.interval * 2 + 5
        status = paint("● live" if fresh else "● stale", P.ok if fresh else P.warn, bold=True)
        status += paint(f" · checked {fmt_dur(age) if age >= 60 else f'{int(age)}s'} ago", P.dim)
        if app.fl and app.fl.stamp:
            status += paint(f" · FlightAware data {fmt_dur(now - app.fl.stamp)} old", P.dim)
    return right_align(" " + keys, status + " ", w)


def render(app, W, H, now):
    fl = app.fl
    if W < 80 or H < 20:
        return [paint(f"Terminal too small: {W}x{H}. Need at least 80x20.", P.warn)]
    if fl is None:
        spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[int(now * 8) % 10]
        msg = paint(f"{spin}  Contacting FlightAware…", P.acc, bold=True)
        lines = [""] * (H // 2 - 2) + [" " * max(0, (W - 28) // 2) + msg]
        if app.err:
            lines += ["", " " * 2 + paint(app.err, P.bad), " " * 2 + paint(retry_text(app, now) + ". Press r to try now.", P.dim)]
        return lines
    pos = position(fl, now)
    wide = W >= 100
    box_h = 6
    map_h = H - 3 - 2 - box_h - 1
    lines = header(fl, pos, now, W)
    air = fl.off_a and not fl.on_a
    legend = paint("━", P.flown) + paint(" flown  ", P.dim) + paint("┄", P.plan) + paint(" planned", P.dim)
    if wide:
        rw = 34
        mw = W - rw - 1
        m = box(render_map(fl, pos, mw - 2, map_h - 2, now), mw, map_h, title=paint("ROUTE", P.acc, bold=True), right=legend, pad=0)
        lines += hjoin([m, gauges(fl, pos, now, rw, map_h)])
    else:
        lines += box(render_map(fl, pos, W - 2, map_h - 2, now), W, map_h, title=paint("ROUTE", P.acc, bold=True), right=legend, pad=0)
    lines += progress_lines(fl, pos, now, W, wide)
    half = (W - 1) // 2
    lines += hjoin([airport_box(fl, fl.org, now, half, box_h, True),
                    airport_box(fl, fl.dst, now, W - half - 1, box_h, False)])
    lines.append(footer(app, W, now))
    return lines


# --------------------------------------------------------------------------- notifications

def notify(title, msg, sound=False):
    script = ("on run argv\n display notification (item 2 of argv) with title (item 1 of argv)"
              + (' sound name "Glass"' if sound else "") + "\nend run")
    try:
        subprocess.Popen(["osascript", "-e", script, title, msg], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def events(prev, cur, st, now, pos_every):
    """Messages for what changed between two checks: [(message, play_sound)]."""
    out = []
    ck = lambda ep, a: tz_clock(ep, a.tz, now, False)
    dst = cur.dst.code
    if cur.cancelled and not prev.cancelled:
        out.append(("❌ Flight cancelled.", True))
    if (cur.diverted and not prev.diverted) or cur.dst.code != prev.dst.code:
        out.append((f"⚠️ Diverted to {dst}.", True))
    if cur.dep_a and not prev.dep_a:
        out.append((f"🚪 Left the gate at {ck(cur.dep_a, cur.org)}.", False))
    if cur.off_a and not prev.off_a:
        out.append((f"🛫 Took off at {ck(cur.off_a, cur.org)}. Arrives ~{ck(cur.arr_e or cur.arr_s, cur.dst)}.", True))
        st["last_pos"] = now
    if cur.on_a and not prev.on_a:
        gate = " · ".join(x for x in (f"Terminal {cur.dst.term}" if cur.dst.term else "", f"gate {cur.dst.gate}" if cur.dst.gate else "") if x)
        out.append((f"🛬 Landed at {dst} at {ck(cur.on_a, cur.dst)}." + (f" {gate}." if gate else ""), True))
    if cur.arr_a and not prev.arr_a:
        out.append((f"✅ At the gate at {ck(cur.arr_a, cur.dst)}.", True))
    st.setdefault("dep_est", cur.dep_e)
    st.setdefault("arr_est", cur.arr_e)
    moved = lambda a, b: a is not None and b is not None and abs(a - b) >= SHIFT_MIN * 60
    if not cur.dep_a and moved(cur.dep_e, st["dep_est"]):
        out.append((f"🕒 Departure now {ck(cur.dep_e, cur.org)}. It was {ck(st['dep_est'], cur.org)}.", False))
        st["dep_est"] = cur.dep_e
    if not cur.on_a and moved(cur.arr_e, st["arr_est"]):
        out.append((f"🕒 Arrival now ~{ck(cur.arr_e, cur.dst)}. It was {ck(st['arr_est'], cur.dst)}.", False))
        st["arr_est"] = cur.arr_e
    for a, b, where, done in ((cur.org, prev.org, "Departure", cur.dep_a), (cur.dst, prev.dst, "Arrival", cur.arr_a)):
        if not done and (a.term or a.gate) and (a.term, a.gate) != (b.term, b.gate):
            gate = " · ".join(x for x in (f"Terminal {a.term}" if a.term else "", f"gate {a.gate}" if a.gate else "") if x)
            out.append((f"🚪 {where} at {a.code}: {gate}.", False))
    if pos_every and cur.off_a and not cur.on_a and now - st.get("last_pos", now) >= pos_every * 60:
        p = position(cur, now)
        frac, done, rem = progress(cur, p, now)
        out.append((f"📍 Over {cur.place or ocean_name(p.lat, p.lon)} · {fmt_int(rem)} km to go · "
                    f"{int(frac * 100)}% done", False))
        st["last_pos"] = now
    return out


# --------------------------------------------------------------------------- app

class App:
    def __init__(self, args):
        self.args = args
        self.interval = max(30, args.interval)
        self.fl, self.err, self.checked, self.link = None, "", 0.0, None
        self.retry_at = 0.0
        self.notify_on = not args.no_notify
        self.stop, self.wake = threading.Event(), threading.Event()
        self.geo_key, self.geo_name = None, ""
        self.st = {}

    def load(self):
        """Fetch the flight once and keep it in self.fl."""
        a = self.args
        if a.json:
            with open(a.json) as f:
                boot = json.load(f)
        else:
            first = None
            if not self.link:
                first = first_flight(fa_page(f"/live/flight/{resolve_ident(a.flight)}"))
                if not first or not first.get("displayIdent"):
                    raise RuntimeError(f"FlightAware does not know flight {a.flight}")
                self.link = pick_link(first, a.date)
                if not self.link:
                    raise RuntimeError(f"No {a.flight} flight on {a.date} (FlightAware lists about 2 days ahead)")
            # Without -d, the first page already holds the flight we follow. That saves one request.
            boot = {"flights": {"x": first}} if first and not a.date else fa_page(self.link)
        f = first_flight(boot)
        if not f or not f.get("displayIdent"):
            raise RuntimeError("FlightAware sent no data for this flight")
        fl = model(f)
        fl.place = self.place_for(fl)
        prev = self.fl
        self.fl, self.err, self.checked = fl, "", time.time()
        if prev and self.notify_on and not a.json:
            title = f"{fl.name} · {fl.org.code} → {fl.dst.code}"
            for msg, sound in events(prev, fl, self.st, time.time(), a.pos_every):
                notify(title, msg, sound)

    def place_for(self, fl):
        """Name of the region under the plane. Uses OpenStreetMap over land, a small table over water."""
        if not fl.off_a or fl.on_a or not fl.track:
            return ""
        p = position(fl, time.time())
        if not over_land(p.lat, p.lon):
            return ocean_name(p.lat, p.lon)
        key = (round(p.lat * 2), round(p.lon * 2))
        if key != self.geo_key:
            self.geo_key = key
            self.geo_name = ""
            if not self.args.json:
                try:
                    url = ("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&accept-language=en"
                           f"&lat={p.lat:.3f}&lon={p.lon:.3f}")
                    req = urllib.request.Request(url, headers={"User-Agent": SCRIPT_UA})
                    with urllib.request.urlopen(req, timeout=8) as r:
                        ad = json.loads(r.read().decode()).get("address", {})
                    self.geo_name = ", ".join(x for x in (ad.get("state") or ad.get("region") or ad.get("county"),
                                                          ad.get("country")) if x)
                except Exception:
                    pass
        return self.geo_name or "Over land"

    def poll(self):
        backoff = 0
        while not self.stop.is_set():
            wait = self.interval
            try:
                self.load()
                backoff = 0
            except urllib.error.HTTPError as e:
                if e.code == 429:       # Rate limited. Wait longer each time, and obey Retry-After.
                    try:
                        retry_after = int(e.headers.get("Retry-After", 0))
                    except (TypeError, ValueError):
                        retry_after = 0
                    backoff = min(900, max(retry_after, backoff * 2, 120))
                    wait, self.err = backoff, "FlightAware is limiting requests (HTTP 429)"
                else:
                    self.err = f"FlightAware returned HTTP {e.code}"
            except Exception as e:
                self.err = str(e) or e.__class__.__name__
                wait = self.interval if self.fl else 15
            self.retry_at = 0 if not self.err else time.time() + wait
            self.wake.wait(wait)
            self.wake.clear()


def run_tui(app):
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    out = sys.stdout
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    signal.signal(signal.SIGTERM, lambda *_: app.stop.set())
    threading.Thread(target=app.poll, daemon=True).start()
    tty.setcbreak(fd)
    out.write("\x1b[?1049h\x1b[?25l\x1b[2J")
    last = None
    flash = ("", 0.0)
    try:
        while not app.stop.is_set():
            W, H = shutil.get_terminal_size((100, 30))
            now = time.time()
            if resized[0]:
                out.write("\x1b[2J")
                resized[0], last = False, None
            lines = render(app, W, H, now)
            if flash[1] > now:
                lines[-1] = right_align(lines[-1], paint(flash[0], P.warn, bold=True) + " ", W) if lines else ""
            frame = "\x1b[H" + "\x1b[K\n".join(clip(l, W) if vlen(l) > W else l for l in lines[:H]) + "\x1b[K\x1b[J"
            if frame != last:
                out.write(frame)
                out.flush()
                last = frame
            ready, _, _ = select.select([fd], [], [], 0.5)
            if ready:
                for ch in os.read(fd, 32).decode(errors="ignore"):
                    if ch in "qQ\x03":
                        app.stop.set()
                    elif ch in "rR":
                        app.wake.set()
                        flash = ("refreshing…", now + 2)
                    elif ch in "nN":
                        app.notify_on = not app.notify_on
                        flash = ("notifications " + ("on" if app.notify_on else "off"), now + 2)
                last = None
    finally:
        out.write("\x1b[?25h\x1b[?1049l" + RESET)
        out.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("flight", nargs="?")
    ap.add_argument("-d", "--date")
    ap.add_argument("-i", "--interval", type=int, default=60)
    ap.add_argument("--pos-every", type=int, default=30)
    ap.add_argument("--no-notify", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--size")
    ap.add_argument("--json")
    ap.add_argument("--now", type=float)
    ap.add_argument("-h", "--help", action="store_true")
    args = ap.parse_args()
    if args.help or not (args.flight or args.json):
        print(__doc__.strip())
        return 0 if args.help else 1
    if args.date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        sys.exit("-d must look like 2026-10-07.")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    app = App(args)
    if args.once or not sys.stdout.isatty() or not sys.stdin.isatty():
        if not args.once:
            sys.exit("flight-tui needs a terminal. Use --once to print a single frame.")
        try:
            app.load()
        except Exception as e:
            sys.exit(f"Error: {e}")
        if args.size:
            W, H = (int(v) for v in args.size.lower().split("x"))
        else:
            W, H = shutil.get_terminal_size((110, 34))
        now = args.now or time.time()
        print("\n".join(render(app, W, H, now)))
        return 0
    run_tui(app)
    return 0


if __name__ == "__main__":
    sys.exit(main())
