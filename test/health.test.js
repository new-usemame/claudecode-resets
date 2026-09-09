import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setKv } from "../src/store.js";
import { fetcherHealth, snowflakeToDate } from "../src/fetcher.js";
import { computeStats, buildCalendar } from "../src/stats.js";

const freshDb = () => openDb(mkdtempSync(join(tmpdir(), "ccr-test-")));

test("a throttled tick is not an outage", () => {
  const db = freshDb();
  // Discovery succeeded 10 minutes ago; the ticks since then found nothing because
  // the timeline 429s and search is deliberately throttled. That is normal.
  setKv(db, "fetch:ok:ClaudeDevs", new Date(Date.now() - 10 * 60_000).toISOString());
  const [h] = fetcherHealth(db);
  assert.equal(h.alerting, false);
  assert.equal(h.minutes_since_discovery, 10);
});

test("a source that has been blind for hours does alert", () => {
  const db = freshDb();
  setKv(db, "fetch:ok:ClaudeDevs", new Date(Date.now() - 5 * 60 * 60_000).toISOString());
  const [h] = fetcherHealth(db);
  assert.equal(h.alerting, true);
});

test("never having succeeded is a starting state, not an outage", () => {
  const [h] = fetcherHealth(freshDb());
  assert.equal(h.last_success, null);
  assert.equal(h.alerting, false);
});

test("snowflake ids decode to the post's real time", () => {
  // 2044868953206612154 is @ClaudeDevs' 2026-04-16T20:02:04Z reset announcement.
  assert.equal(snowflakeToDate("2044868953206612154").toISOString().slice(0, 19),
               "2026-04-16T20:02:04");
});

test("policy changes never inflate the reset stats", () => {
  const db = freshDb();
  const resets = db.prepare("SELECT * FROM events WHERE kind='reset'").all();
  const all = db.prepare("SELECT * FROM events").all();
  assert.ok(all.length > resets.length, "fixture should contain policy rows too");
  assert.equal(computeStats(resets).total, resets.length);
  // Every calendar cell with a count must trace back to a reset, never a policy row.
  const resetDays = new Set(resets.map((r) => r.announced_at.slice(0, 10)));
  for (const cell of buildCalendar(resets).cells) {
    if (cell.count > 0) assert.ok(resetDays.has(cell.date), `${cell.date} is not a reset day`);
  }
});

test("the calendar ends today and never draws the future", () => {
  const db = freshDb();
  const resets = db.prepare("SELECT * FROM events WHERE kind='reset'").all();
  const cal = buildCalendar(resets);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(cal.cells.at(-1).date, today);
  assert.ok(cal.cells.every((c) => c.date <= today));
});
