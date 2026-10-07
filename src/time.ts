// Clocks and durations. All times are Unix seconds, shown in the local time of a named zone.

export interface ZoneParts {
  year: string;
  month: string;
  day: string;
  weekday: string;
  hour: string;
  minute: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, locale: string, extra: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${Object.keys(extra).join(",")}`;
  let f = formatters.get(key);
  if (!f) {
    const base: Intl.DateTimeFormatOptions = {
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...extra,
    };
    try {
      f = new Intl.DateTimeFormat(locale, { ...base, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat(locale, { ...base, timeZone: "UTC" });
    }
    formatters.set(key, f);
  }
  return f;
}

function parts(epoch: number, f: Intl.DateTimeFormat): Map<string, string> {
  return new Map(f.formatToParts(new Date(epoch * 1000)).map((p) => [p.type, p.value]));
}

export function zoneParts(epoch: number, tz: string): ZoneParts {
  const p = parts(epoch, formatter(tz, "en-GB", {}));
  return {
    year: p.get("year") ?? "",
    month: p.get("month") ?? "",
    day: p.get("day") ?? "",
    weekday: p.get("weekday") ?? "",
    hour: p.get("hour") ?? "",
    minute: p.get("minute") ?? "",
  };
}

/** The zone's own short name, such as "EDT" or "EEST". Falls back to "GMT+3". */
export function zoneAbbr(epoch: number, tz: string): string {
  for (const locale of ["en-US", "en-GB"]) {
    const name = parts(epoch, formatter(tz, locale, { timeZoneName: "short" })).get("timeZoneName") ?? "";
    if (name && !name.startsWith("GMT") && !name.startsWith("UTC")) return name;
  }
  return parts(epoch, formatter(tz, "en-US", { timeZoneName: "short" })).get("timeZoneName") ?? "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The calendar day in the zone, as "2026-10-07". */
export function localDate(epoch: number, tz: string): string {
  const p = zoneParts(epoch, tz);
  const month = String(MONTHS.indexOf(p.month) + 1).padStart(2, "0");
  return `${p.year}-${month}-${p.day.padStart(2, "0")}`;
}

/** "13:27", or "Thu 06:05" when the day is not today in that zone. Adds the zone name unless abbr is false. */
export function clock(epoch: number | null, tz: string, now: number, abbr = true): string {
  if (epoch === null) return "—";
  const p = zoneParts(epoch, tz);
  let s = `${p.hour}:${p.minute}`;
  if (localDate(epoch, tz) !== localDate(now, tz)) s = `${p.weekday} ${s}`;
  return abbr ? `${s} ${zoneAbbr(epoch, tz)}` : s;
}

/** "Wed 7 Oct", or "Wed 7 Oct 2026" with year. */
export function dayLabel(epoch: number, tz: string, withYear = false): string {
  const p = zoneParts(epoch, tz);
  return `${p.weekday} ${p.day} ${p.month}${withYear ? ` ${p.year}` : ""}`;
}

/** "2h 41m", "41 min" or "<1 min". */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m} min` : "<1 min";
}

/** "36,000". */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
