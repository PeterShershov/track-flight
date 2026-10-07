// The app: it keeps the latest flight and checks FlightAware on a timer.

import { readFile } from "node:fs/promises";
import { fetchPage, firstFlight, HttpError, pickLink, resolveIdent, reverseGeocode } from "./flightaware.ts";
import { inAir, parseFlight, position, type Flight } from "./flight.ts";
import { oceanName, overLand } from "./geo.ts";
import type { Snapshot } from "./panels.ts";

export interface Options {
  /** Flight number, such as "UA125". Not needed with `json`. */
  flight: string;
  /** Departure date as YYYY-MM-DD, or null for the current flight. */
  date: string | null;
  /** Seconds between checks. */
  interval: number;
  /** Test aid: read the flight from this saved FlightAware JSON file. */
  json: string | null;
}

export class App implements Snapshot {
  fl: Flight | null = null;
  err = "";
  checked = 0;
  retryAt = 0;
  notice = "";
  readonly interval: number;

  private readonly opts: Options;
  private link: string | null = null;
  private geoKey = "";
  private geoName = "";
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(opts: Options) {
    this.opts = opts;
    this.interval = Math.max(30, opts.interval);
  }

  /** Fetch the flight once and keep it in `fl`. Throws when it cannot. */
  async load(): Promise<void> {
    const { opts } = this;
    let raw: unknown;
    if (opts.json) {
      raw = firstFlight(JSON.parse(await readFile(opts.json, "utf8")));
    } else if (this.link) {
      raw = firstFlight(await fetchPage(this.link));
    } else {
      const first = firstFlight(await fetchPage(`/live/flight/${await resolveIdent(opts.flight)}`));
      if (!parseFlight(first)) throw new Error(`FlightAware does not know flight ${opts.flight}`);
      this.link = pickLink(first, opts.date);
      if (!this.link)
        throw new Error(
          opts.date
            ? `No ${opts.flight} flight on ${opts.date} (FlightAware lists about 2 days ahead)`
            : `No current ${opts.flight} flight found`,
        );
      // Without a date, the first page already holds the flight we follow. That saves one request.
      raw = opts.date ? firstFlight(await fetchPage(this.link)) : first;
    }
    const fl = parseFlight(raw);
    if (!fl) throw new Error("FlightAware sent no data for this flight");
    fl.place = await this.placeFor(fl);

    this.fl = fl;
    this.err = "";
    this.checked = Date.now() / 1000;
  }

  /** The region under the plane. OpenStreetMap names land, a small table names the sea. */
  private async placeFor(fl: Flight): Promise<string> {
    if (!inAir(fl) || !fl.track.length) return "";
    const p = position(fl, Date.now() / 1000);
    if (!overLand(p.lat, p.lon)) return oceanName(p.lat, p.lon);
    const key = `${Math.round(p.lat * 2)},${Math.round(p.lon * 2)}`;
    if (key !== this.geoKey) {
      this.geoKey = key;
      this.geoName = this.opts.json ? "" : await reverseGeocode(p);
    }
    return this.geoName || "Over land";
  }

  /** Check on a timer until `stop`. After a rate limit (HTTP 429) it waits longer each time. */
  async poll(): Promise<void> {
    let backoff = 0;
    while (!this.stopped) {
      let wait = this.interval;
      try {
        await this.load();
        backoff = 0;
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
          backoff = Math.min(900, Math.max(e.retryAfter, backoff * 2, 120));
          wait = backoff;
          this.err = "FlightAware is limiting requests (HTTP 429)";
        } else if (e instanceof HttpError) {
          this.err = `FlightAware returned HTTP ${e.status}`;
        } else {
          this.err = e instanceof Error && e.message ? e.message : "Something went wrong";
          if (!this.fl) wait = 15;
        }
      }
      this.retryAt = this.err ? Date.now() / 1000 + wait : 0;
      await this.sleep(wait * 1000);
    }
  }

  /** Check again now, instead of waiting for the timer. */
  refresh(): void {
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
