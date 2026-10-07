import assert from "node:assert/strict";
import { test } from "node:test";
import { box, clip, fit, hjoin, mix, paint, P, rightAlign, vlen } from "./ansi.ts";

test("vlen ignores color codes", () => {
  assert.equal(vlen(paint("hello", P.acc, true)), 5);
  assert.equal(vlen(""), 0);
});

test("clip cuts to the visible width and keeps the codes", () => {
  const s = paint("hello", P.acc) + paint("world", P.ok);
  assert.equal(vlen(clip(s, 7)), 7);
  assert.equal(vlen(clip(s, 100)), 10);
  assert.equal(vlen(clip(s, 0)), 0);
});

test("fit pads and cuts to exactly the width", () => {
  assert.equal(vlen(fit("ab", 6)), 6);
  assert.equal(vlen(fit(paint("abcdefgh", P.acc), 6)), 6);
});

test("rightAlign puts the right part at the edge", () => {
  const line = rightAlign("left", "right", 20);
  assert.equal(vlen(line), 20);
  assert.ok(line.endsWith("right"));
  assert.equal(vlen(rightAlign("a very long left side", "right", 10)), 10);
});

test("box is exactly w by h, with a title that may be too long", () => {
  const lines = box(["one", paint("two", P.ok)], 30, 6, { title: "TITLE", right: "right" });
  assert.equal(lines.length, 6);
  for (const l of lines) assert.equal(vlen(l), 30);
  for (const l of box(["x"], 12, 4, { title: "A title that cannot fit here" })) assert.equal(vlen(l), 12);
});

test("hjoin puts blocks side by side, even when one is shorter", () => {
  assert.deepEqual(hjoin([["a", "b"], ["c"]], 1), ["a c", "b "]);
});

test("mix stays between the two colors", () => {
  assert.deepEqual(mix([0, 0, 0], [100, 200, 50], 0.5), [50, 100, 25]);
  assert.deepEqual(mix([0, 0, 0], [100, 200, 50], 5), [100, 200, 50]);
  assert.deepEqual(mix([0, 0, 0], [100, 200, 50], -5), [0, 0, 0]);
});
