// A real UA125 flight (Athens to Newark), trimmed. Shared by the tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstFlight } from "./flightaware.ts";
import { parseFlight, type Flight } from "./flight.ts";

export const page: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "ua125.json"), "utf8"));

/** When the fixture was captured: the time of its last track point. */
export const CAPTURED = 1791381081;

/** A fresh copy each call, so a test can change it. */
export function fixtureFlight(): Flight {
  const fl = parseFlight(firstFlight(page));
  if (!fl) throw new Error("The fixture holds no flight");
  return structuredClone(fl);
}
