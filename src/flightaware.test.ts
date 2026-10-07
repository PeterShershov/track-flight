import assert from "node:assert/strict";
import http2 from "node:http2";
import { afterEach, mock, test } from "node:test";
import { gzipSync } from "node:zlib";
import { fetchPage, firstFlight, httpGet, HttpError, pickLink, resolveIdent, reverseGeocode } from "./flightaware.ts";
import { page } from "./fixture.ts";
import { fakeFa, fakeFetch, html } from "./test-helpers.ts";

afterEach(() => mock.restoreAll());

test("fetchPage reads the flight data out of the page", async () => {
  fakeFa(() => new Response(html({ flights: { x: { displayIdent: "UAL125" } } })));
  const data = await fetchPage("/live/flight/UAL125");
  assert.deepEqual(firstFlight(data), { displayIdent: "UAL125" });
});

test("fetchPage copes with ';</script>' inside a string", async () => {
  fakeFa(
    () =>
      new Response(
        html({ flights: { x: { remarks: "a;<\\/script>b", displayIdent: "X" } } }).replace("<\\/", "<\\u002f"),
      ),
  );
  assert.ok(firstFlight(await fetchPage("/x")));
});

test("fetchPage fails clearly on a page without data, or with broken data", async () => {
  fakeFa(() => new Response("<html>hello</html>"));
  await assert.rejects(fetchPage("/x"), /without flight data/);
  mock.restoreAll();
  fakeFa(() => new Response("<script>var trackpollBootstrap = {oops</script>"));
  await assert.rejects(fetchPage("/x"), /cannot read/);
});

test("a 429 becomes an HttpError that carries Retry-After", async () => {
  fakeFa(() => new Response("slow down", { status: 429, headers: { "retry-after": "300" } }));
  await assert.rejects(
    fetchPage("/x"),
    (e: unknown) => e instanceof HttpError && e.status === 429 && e.retryAfter === 300,
  );
  mock.restoreAll();
  fakeFa(() => new Response("", { status: 503 }));
  await assert.rejects(
    fetchPage("/x"),
    (e: unknown) => e instanceof HttpError && e.status === 503 && e.retryAfter === 0,
  );
});

test("resolveIdent picks the airline's code, and falls back to the input", async () => {
  fakeFa(() =>
    Response.json({
      data: [
        { ident: "LH400", major_airline: "0" },
        { ident: "DLH400", major_airline: "1" },
      ],
    }),
  );
  assert.equal(await resolveIdent("lh 400"), "DLH400");
  mock.restoreAll();
  fakeFa(() => new Response("", { status: 500 }));
  assert.equal(await resolveIdent("ua 125"), "UA125");
  mock.restoreAll();
  fakeFa(() => Response.json({ data: [] }));
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

// The real transport, against a local HTTP/2 server.

type Handler = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void;

async function serve(handler: Handler): Promise<{ origin: string; stop: () => void }> {
  const server = http2.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => server.close() };
}

test("httpGet reads a page over HTTP/2 and sends browser headers", async () => {
  let seen: http2.IncomingHttpHeaders = {};
  const { origin, stop } = await serve((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("héllo");
  });
  try {
    assert.equal(await httpGet("/live/flight/X?a=1", { origin }), "héllo");
    assert.equal(seen[":path"], "/live/flight/X?a=1");
    assert.match(String(seen["user-agent"]), /Mozilla\/5\.0 .*Chrome/);
    assert.equal(seen["accept-encoding"], "gzip");
  } finally {
    stop();
  }
});

test("httpGet unzips a gzip reply", async () => {
  const { origin, stop } = await serve((_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(gzipSync("zipped ✈"));
  });
  try {
    assert.equal(await httpGet("/", { origin }), "zipped ✈");
  } finally {
    stop();
  }
});

test("httpGet turns a bad status into an HttpError with Retry-After", async () => {
  const { origin, stop } = await serve((req, res) => {
    res.writeHead(req.url === "/limited" ? 429 : 500, req.url === "/limited" ? { "retry-after": "120" } : {});
    res.end("no");
  });
  try {
    await assert.rejects(
      httpGet("/limited", { origin }),
      (e: unknown) => e instanceof HttpError && e.status === 429 && e.retryAfter === 120,
    );
    await assert.rejects(
      httpGet("/other", { origin }),
      (e: unknown) => e instanceof HttpError && e.status === 500 && e.retryAfter === 0,
    );
  } finally {
    stop();
  }
});

test("httpGet gives up when the server does not answer", async () => {
  const { origin, stop } = await serve(() => {});
  try {
    await assert.rejects(httpGet("/", { origin, timeoutMs: 100 }), /did not answer in time/);
  } finally {
    stop();
  }
});

test("httpGet fails when nothing is listening", async () => {
  const { origin, stop } = await serve(() => {});
  stop();
  await assert.rejects(httpGet("/", { origin }), /ECONNREFUSED|connect/i);
});
