import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCli } from "./cli.ts";

test("defaults", () => {
  const cli = parseCli(["UA125"]);
  assert.deepEqual(cli.opts, { flight: "UA125", date: null, interval: 60, posEvery: 30, notify: true, json: null });
  assert.equal(cli.once, false);
  assert.equal(cli.help, false);
  assert.equal(cli.size, null);
  assert.equal(cli.now, null);
});

test("every option", () => {
  const cli = parseCli([
    "-d",
    "2026-10-09",
    "-i",
    "45",
    "--pos-every",
    "0",
    "--no-notify",
    "--once",
    "--size",
    "110x34",
    "--now",
    "5",
    "UA125",
  ]);
  assert.deepEqual(cli.opts, {
    flight: "UA125",
    date: "2026-10-09",
    interval: 45,
    posEvery: 0,
    notify: false,
    json: null,
  });
  assert.equal(cli.once, true);
  assert.deepEqual(cli.size, [110, 34]);
  assert.equal(cli.now, 5);
  assert.equal(parseCli(["-h"]).help, true);
  assert.equal(parseCli(["--json", "x.json"]).opts.json, "x.json");
});

test("bad input gets a plain message", () => {
  assert.throws(() => parseCli(["-d", "2026/10/09", "UA125"]), /-d must look like 2026-10-07/);
  assert.throws(() => parseCli(["--size", "wide", "UA125"]), /--size must look like 110x34/);
  assert.throws(() => parseCli(["-i", "soon", "UA125"]), /-i must be a whole number/);
  assert.throws(() => parseCli(["--pos-every", "-5", "UA125"]), /Unknown option|--pos-every|expected a value/i);
  assert.throws(() => parseCli(["--nope", "UA125"]), /--nope/);
});
