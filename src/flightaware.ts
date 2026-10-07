// Talking to FlightAware. We read the public flight page. This is not an official API.

import http2 from "node:http2";
import { gunzipSync } from "node:zlib";
import { list, num, rec, str } from "./json.ts";
import { localDate } from "./time.ts";

const FA = "https://www.flightaware.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export class HttpError extends Error {
  status: number;
  /** Seconds FlightAware asked us to wait, or 0. */
  retryAfter: number;

  constructor(status: number, retryAfter: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface GetOptions {
  timeoutMs?: number;
  /** Where to connect. Only the tests change this. */
  origin?: string;
}

/**
 * GET a page from FlightAware over HTTP/2. Its firewall answers 429 to the same request over HTTP/1.1,
 * which is what `fetch` in Node uses, so we cannot use `fetch` here.
 */
export function httpGet(path: string, { timeoutMs = 30_000, origin = FA }: GetOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(origin);
    const fail = (e: Error) => {
      session.destroy();
      reject(e);
    };
    session.on("error", fail);
    session.setTimeout(timeoutMs, () => fail(new Error("FlightAware did not answer in time")));
    const req = session.request({
      ":path": path,
      "user-agent": BROWSER_UA,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip",
    });
    let status = 0;
    let gzip = false;
    let retryAfter = 0;
    const chunks: Buffer[] = [];
    req.on("response", (headers) => {
      status = Number(headers[":status"]);
      gzip = String(headers["content-encoding"] ?? "") === "gzip";
      retryAfter = Number(headers["retry-after"]) || 0;
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", fail);
    req.on("end", () => {
      session.close();
      if (status < 200 || status >= 300) return reject(new HttpError(status, retryAfter));
      try {
        const body = Buffer.concat(chunks);
        resolve((gzip ? gunzipSync(body) : body).toString("utf8"));
      } catch {
        reject(new Error("FlightAware sent a reply we cannot read"));
      }
    });
    req.end();
  });
}

/** The network calls, in one place so the tests can replace them. */
export const transport = { get: httpGet };

/** The flight data that FlightAware puts in a page, as untyped JSON. */
export async function fetchPage(path: string): Promise<unknown> {
  const marker = "var trackpollBootstrap = ";
  const html = await transport.get(path);
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("FlightAware sent a page without flight data");
  const end = html.indexOf("</script>", start);
  const text = html.slice(start + marker.length, end < 0 ? undefined : end).trim();
  try {
    const parsed: unknown = JSON.parse(text.endsWith(";") ? text.slice(0, -1) : text);
    return parsed;
  } catch {
    throw new Error("FlightAware sent flight data we cannot read");
  }
}

/** The first flight object in a page's data. */
export function firstFlight(page: unknown): unknown {
  return Object.values(rec(rec(page)["flights"]))[0];
}

/** Turn "UA125" into FlightAware's "UAL125". Falls back to the input. */
export async function resolveIdent(query: string): Promise<string> {
  const q = query.replace(/\s+/g, "").toUpperCase();
  try {
    const path = `/ajax/ignoreall/omnisearch/flight.rvt?v=50&locale=en_US&searchterm=${q}&q=${q}`;
    const data = list(rec(JSON.parse(await transport.get(path, { timeoutMs: 20_000 })))["data"]).map(rec);
    const best = data.find((d) => d["major_airline"] === "1") ?? data[0];
    return str(best?.["ident"]) || q;
  } catch {
    return q;
  }
}

/** Page path of the flight to follow: today's by default, or the one that departs on `date` (YYYY-MM-DD). */
export function pickLink(flight: unknown, date: string | null): string | null {
  const f = rec(flight);
  if (!date) return str(rec(f["links"])["permanent"]) || null;
  for (const item of list(rec(f["activityLog"])["flights"])) {
    const leg = rec(item);
    const tz = str(rec(leg["origin"])["TZ"]).replace(/^:/, "") || "UTC";
    const ts = num(rec(leg["gateDepartureTimes"])["scheduled"]) ?? num(rec(leg["takeoffTimes"])["scheduled"]);
    if (ts !== null && localDate(ts, tz) === date) return str(leg["permaLink"]) || null;
  }
  return null;
}

export interface Place {
  lat: number;
  lon: number;
}

/** "State, Country" for a point over land, from OpenStreetMap. Returns "" on any failure. */
export async function reverseGeocode({ lat, lon }: Place): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&accept-language=en&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "flight-tui/1.0 (personal flight tracker)" },
      signal: AbortSignal.timeout(8_000),
    });
    const body: unknown = await res.json();
    const a = rec(rec(body)["address"]);
    return [str(a["state"]) || str(a["region"]) || str(a["county"]), str(a["country"])].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}
