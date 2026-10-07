import assert from "node:assert/strict";
import { test } from "node:test";
import { bearing, destination, gcPoints, havKm, land, oceanName, overLand, sunElevation, sunState } from "./geo.ts";

const near = (a: number, b: number, tol: number) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("havKm: Athens to Newark is about 7,956 km", () => {
  near(havKm(37.9364, 23.9445, 40.6925, -74.1687), 7956, 15);
  assert.equal(havKm(10, 10, 10, 10), 0);
});

test("bearing", () => {
  near(bearing(0, 0, 10, 0), 0, 0.01);
  near(bearing(0, 0, 0, 10), 90, 0.01);
  near(bearing(10, 0, 0, 0), 180, 0.01);
  near(bearing(0, 10, 0, 0), 270, 0.01);
});

test("destination goes the distance along the bearing", () => {
  const [lat, lon] = destination(10, 20, 0, 111.195);
  near(lat, 11, 0.01);
  near(lon, 20, 0.01);
  const [lat2, lon2] = destination(40, -30, 77, 500);
  near(havKm(40, -30, lat2, lon2), 500, 0.5);
  near(bearing(40, -30, lat2, lon2), 77, 0.5);
});

test("destination wraps across the date line", () => {
  const [, lon] = destination(0, 179, 90, 300);
  assert.ok(lon < -170 && lon > -180, String(lon));
});

test("gcPoints starts and ends at the two places", () => {
  const pts = gcPoints(37.9, 23.9, 40.7, -74.2);
  const first = pts[0];
  const last = pts.at(-1);
  assert.ok(first && last);
  near(first[0], 23.9, 0.01);
  near(first[1], 37.9, 0.01);
  near(last[0], -74.2, 0.01);
  near(last[1], 40.7, 0.01);
  assert.equal(gcPoints(1, 2, 1, 2).length, 1);
});

test("the sun is overhead at noon on the equinox and gone on the other side", () => {
  const noon = Date.UTC(2026, 2, 20, 12, 0) / 1000;
  const sun = sunState(noon);
  near(sun.decl, 0, 0.03);
  assert.ok(sunElevation(0, 0, sun) > 85);
  assert.ok(sunElevation(0, 180, sun) < -85);
});

test("in June the sun stands about 23.4 degrees north", () => {
  near((sunState(Date.UTC(2026, 5, 21, 12) / 1000).decl * 180) / Math.PI, 23.4, 0.5);
});

test("overLand knows land from sea", () => {
  assert.ok(land().length > 1000, "land.json did not load");
  assert.ok(overLand(37.98, 23.73), "Athens");
  assert.ok(overLand(48.85, 2.35), "Paris");
  assert.ok(overLand(40.7, -74.0), "New York");
  assert.ok(!overLand(42.3, -35.4), "mid-Atlantic");
  assert.ok(!overLand(0, -140), "Pacific");
});

test("oceanName", () => {
  assert.equal(oceanName(42.3, -35.4), "North Atlantic Ocean");
  assert.equal(oceanName(36, 18), "Mediterranean Sea");
  assert.equal(oceanName(-30, -20), "South Atlantic Ocean");
  assert.equal(oceanName(80, 0), "Arctic Ocean");
});
