import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { fetchPage, firstFlight, HttpError, pickLink, resolveIdent, reverseGeocode } from "./flightaware.ts";
import { page } from "./fixture.ts";
import { fakeFetch, html } from "./test-helpers.ts";

afterEach(() => mock.restoreAll());

test("fetchPage reads the flight data out of the page", async () => {
  fakeFetch(() => new Response(html({ flights: { x: { displayIdent: "UAL125" } } })));
  const data = await fetchPage("/live/flight/UAL125");
  assert.deepEqual(firstFlight(data), { displayIdent: "UAL125" });
});

test("fetchPage copes with ';</script>' inside a string", async () => {
  fakeFetch(
    () =>
      new Response(
        html({ flights: { x: { remarks: "a;<\\/script>b", displayIdent: "X" } } }).replace("<\\/", "<\\u002f"),
      ),
  );
  assert.ok(firstFlight(await fetchPage("/x")));
});

test("fetchPage fails clearly on a page without data, or with broken data", async () => {
  fakeFetch(() => new Response("<html>hello</html>"));
  await assert.rejects(fetchPage("/x"), /without flight data/);
  mock.restoreAll();
  fakeFetch(() => new Response("<script>var trackpollBootstrap = {oops</script>"));
  await assert.rejects(fetchPage("/x"), /cannot read/);
});

test("a 429 becomes an HttpError that carries Retry-After", async () => {
  fakeFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "300" } }));
  await assert.rejects(
    fetchPage("/x"),
    (e: unknown) => e instanceof HttpError && e.status === 429 && e.retryAfter === 300,
  );
  mock.restoreAll();
  fakeFetch(() => new Response("", { status: 503 }));
  await assert.rejects(
    fetchPage("/x"),
    (e: unknown) => e instanceof HttpError && e.status === 503 && e.retryAfter === 0,
  );
});

test("resolveIdent picks the airline's code, and falls back to the input", async () => {
  fakeFetch(() =>
    Response.json({
      data: [
        { ident: "LH400", major_airline: "0" },
        { ident: "DLH400", major_airline: "1" },
      ],
    }),
  );
  assert.equal(await resolveIdent("lh 400"), "DLH400");
  mock.restoreAll();
  fakeFetch(() => new Response("", { status: 500 }));
  assert.equal(await resolveIdent("ua 125"), "UA125");
  mock.restoreAll();
  fakeFetch(() => Response.json({ data: [] }));
  assert.equal(await resolveIdent("ua125"), "UA125");
});

test("pickLink follows the current flight, or the one on a date", () => {
  const f = firstFlight(page);
  assert.equal(pickLink(f, null), "/live/flight/UAL125/history/20261007/0735Z/LGAV/KEWR");
  assert.equal(pickLink(f, "2026-10-08"), "/live/flight/UAL125/history/20261008/0735Z/LGAV/KEWR");
  assert.equal(pickLink(f, "2026-10-06"), "/live/flight/UAL125/history/20261006/0735Z/LGAV/KEWR");
  assert.equal(pickLink(f, "2020-01-01"), null);
  assert.equal(pickLink({}, null), null);
  assert.equal(pickLink(undefined, "2026-10-08"), null);
});

test("reverseGeocode names the region, and gives '' on any failure", async () => {
  const urls = fakeFetch(() => Response.json({ address: { state: "Castile and León", country: "Spain" } }));
  assert.equal(await reverseGeocode({ lat: 42.86, lon: -5.26 }), "Castile and León, Spain");
  assert.match(urls[0] ?? "", /lat=42\.860&lon=-5\.260/);
  mock.restoreAll();
  fakeFetch(() => Response.json({ address: { country: "Iceland" } }));
  assert.equal(await reverseGeocode({ lat: 64, lon: -19 }), "Iceland");
  mock.restoreAll();
  fakeFetch(() => new Response("not json", { status: 500 }));
  assert.equal(await reverseGeocode({ lat: 0, lon: 0 }), "");
});
