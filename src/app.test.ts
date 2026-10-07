import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { App, type Options } from "./app.ts";
import { page } from "./fixture.ts";
import { fakeFa, fakeFetch, html, until } from "./test-helpers.ts";

afterEach(() => mock.restoreAll());

const opts: Options = { flight: "UA125", date: null, interval: 60, json: null };

const flightAware = (url: string) =>
  url.includes("omnisearch")
    ? Response.json({ data: [{ ident: "UAL125", major_airline: "1" }] })
    : new Response(html(page));

test("load follows the flight with two requests: the search and the page", async () => {
  const urls = fakeFa(flightAware);
  const app = new App(opts);
  await app.load();
  assert.equal(app.fl?.name, "United 125");
  assert.equal(app.err, "");
  assert.ok(app.checked > 0);
  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? "", /omnisearch.*UA125/);
  assert.match(urls[1] ?? "", /\/live\/flight\/UAL125$/);
  await app.load(); // the next check goes straight to the flight's own page
  assert.equal(urls.length, 3);
  assert.match(urls[2] ?? "", /UAL125\/history\/20261007/);
});

test("load with a date fetches that day's page", async () => {
  const urls = fakeFa(flightAware);
  await new App({ ...opts, date: "2026-10-08" }).load();
  assert.equal(urls.length, 3);
  assert.match(urls[2] ?? "", /history\/20261008/);
});

test("load names the sea under the plane without asking OpenStreetMap", async () => {
  fakeFa(flightAware);
  const openStreetMap = fakeFetch(() => Response.json({ address: { country: "Nowhere" } }));
  const app = new App(opts);
  await app.load();
  assert.equal(app.fl?.place, "North Atlantic Ocean");
  assert.deepEqual(openStreetMap, []);
});

test("load says so when FlightAware does not know the flight, or the date", async () => {
  fakeFa(() => new Response(html({ flights: { INVALID: { displayIdent: null } } })));
  await assert.rejects(new App(opts).load(), /does not know flight UA125/);
  mock.restoreAll();
  fakeFa(flightAware);
  await assert.rejects(new App({ ...opts, date: "2020-01-01" }).load(), /No UA125 flight on 2020-01-01/);
});

test("load can read a saved file", async () => {
  const app = new App({ ...opts, flight: "", json: join(import.meta.dirname, "fixtures", "ua125.json") });
  await app.load();
  assert.equal(app.fl?.org.code, "ATH");
});

test("after a 429, poll waits for Retry-After and says so", async () => {
  fakeFa(() => new Response("slow down", { status: 429, headers: { "retry-after": "300" } }));
  const app = new App(opts);
  const running = app.poll();
  await until(() => app.err !== "");
  assert.equal(app.err, "FlightAware is limiting requests (HTTP 429)");
  const wait = app.retryAt - Date.now() / 1000;
  assert.ok(wait > 295 && wait <= 300, String(wait));
  app.stop();
  await running;
});

test("a 429 with no Retry-After waits at least 2 minutes", async () => {
  fakeFa(() => new Response("", { status: 429 }));
  const app = new App(opts);
  const running = app.poll();
  await until(() => app.err !== "");
  const wait = app.retryAt - Date.now() / 1000;
  assert.ok(wait > 115 && wait <= 120, String(wait));
  app.stop();
  await running;
});

test("other errors retry soon when nothing has loaded yet, and on the interval after that", async () => {
  fakeFa(() => new Response("", { status: 503 }));
  const app = new App(opts);
  const running = app.poll();
  await until(() => app.err !== "");
  assert.equal(app.err, "FlightAware returned HTTP 503");
  assert.ok(app.retryAt - Date.now() / 1000 > 55);
  app.stop();
  await running;
});

test("refresh wakes poll up early, and a good check clears the error", async () => {
  let fail = true;
  const urls = fakeFa((url) => (fail ? new Response("", { status: 429 }) : flightAware(url)));
  const app = new App(opts);
  const running = app.poll();
  await until(() => app.err !== "");
  fail = false;
  app.refresh();
  await until(() => app.fl !== null);
  assert.equal(app.err, "");
  assert.equal(app.retryAt, 0);
  assert.ok(urls.length >= 3);
  app.stop();
  await running;
});

test("the interval is never shorter than 30 seconds", () => {
  assert.equal(new App({ ...opts, interval: 5 }).interval, 30);
  assert.equal(new App({ ...opts, interval: 90 }).interval, 90);
});
