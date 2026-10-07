// Small helpers shared by the tests that need a fake network.

import assert from "node:assert/strict";
import { mock } from "node:test";
import { HttpError, transport } from "./flightaware.ts";

/** A FlightAware page that holds this data. */
export const html = (data: unknown) =>
  `<html><script>var trackpollBootstrap = ${JSON.stringify(data)};</script></html>`;

/** Make FlightAware answer with this response. A non-2xx status becomes an HttpError, as in the real transport. Returns the paths asked for. */
export function fakeFa(answer: (path: string) => Response): string[] {
  const paths: string[] = [];
  mock.method(transport, "get", async (path: string) => {
    paths.push(path);
    const res = answer(path);
    if (!res.ok) throw new HttpError(res.status, Number(res.headers.get("retry-after")) || 0);
    return await res.text();
  });
  return paths;
}

/** Make `fetch` answer with this response (OpenStreetMap). Returns the list of URLs it was asked for. */
export function fakeFetch(answer: (url: string) => Response): string[] {
  const urls: string[] = [];
  mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return Promise.resolve(answer(url));
  });
  return urls;
}

/** Wait until `check` is true. Fails after two seconds. */
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "timed out");
}
