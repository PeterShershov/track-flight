// Small helpers shared by the tests that need a fake network.

import assert from "node:assert/strict";
import { mock } from "node:test";

/** A FlightAware page that holds this data. */
export const html = (data: unknown) =>
  `<html><script>var trackpollBootstrap = ${JSON.stringify(data)};</script></html>`;

/** Make `fetch` answer with this response. Returns the list of URLs it was asked for. */
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
