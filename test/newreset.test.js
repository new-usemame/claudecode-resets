import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, insertEvent, allEvents, resets as allResets } from "../src/store.js";
import { computeStats, buildCalendar } from "../src/stats.js";
import { renderPage } from "../src/render.js";
import { classify } from "../src/classify.js";
import { esc } from "../src/util.js";

const freshDb = () => openDb(mkdtempSync(join(tmpdir(), "ccr-new-")));

/** The page the way a visitor would get it. */
function page(db, now) {
  const events = allEvents(db), resets = allResets(db);
  return renderPage({ events, resets, stats: computeStats(resets, now),
                      calendar: buildCalendar(resets, { now }), vapidKey: null, now });
}

test("a reset detected today reaches the hero, the calendar, the stats and the log", () => {
  const db = freshDb();
  const now = Date.now();
  const before = computeStats(allResets(db), now);

  // Exactly what the fetcher would build from a hydrated post.
  const text = "We've reset 5-hour and weekly rate limits for all users.";
  const verdict = classify(text);
  assert.equal(verdict.kind, "reset");
  assert.equal(verdict.reset_type, "full");

  const announced = new Date(now - 90_000).toISOString();   // 90 seconds ago
  const inserted = insertEvent(db, {
    id: "9999999999999999999", kind: verdict.kind, reset_type: verdict.reset_type,
    scope: verdict.scope, announced_at: announced, text,
    author: "ClaudeDevs", url: "https://x.com/ClaudeDevs/status/9999999999999999999",
    verification: "provisional",
  });
  assert.equal(inserted, true, "a genuinely new id must insert");
  assert.equal(insertEvent(db, { id: "9999999999999999999", kind: "reset", reset_type: "full",
    scope: "all", announced_at: announced, text, author: "ClaudeDevs", url: "x", verification: "provisional" }),
    false, "the same id must not insert twice");

  const after = computeStats(allResets(db), now);
  assert.equal(after.total, before.total + 1, "reset count moves");
  assert.equal(after.days_since_last, 0, "days since last resets to today");
  assert.equal(after.last_reset_at, announced);

  const html = page(db, now);
  assert.match(html, /Latest Claude Code reset/);
  // The page escapes for HTML, so compare against the escaped form — an apostrophe
  // becoming &#39; is correct output, not a missing announcement.
  assert.ok(html.includes(esc(text)), "the new announcement's own words are on the page");
  assert.match(html, /class="log-item-kind log-item-kind--provisional"/,
    "an unreviewed entry is labelled as auto-detected");
  assert.ok(!/hero-sub--partial/.test(html.split("hero-card")[1].split("</div>")[0]),
    "a full reset is not labelled partial in the hero");

  // The calendar must gain today's square, pointing at the source post.
  const today = new Date(now).toISOString().slice(0, 10);
  const cell = buildCalendar(allResets(db), { now }).cells.find((c) => c.date === today);
  assert.equal(cell.count, 1);
  assert.equal(cell.type, "full");
  assert.equal(cell.href, "https://x.com/ClaudeDevs/status/9999999999999999999");
});

test("a limit-policy change reaches the log but moves no number", () => {
  const db = freshDb();
  const now = Date.now();
  const before = computeStats(allResets(db), now);
  const text = "We're permanently raising standard weekly limits in Claude Code by 25% for Pro, Max, Team, and seat-based Enterprise plans.";
  assert.equal(classify(text).kind, "policy");

  insertEvent(db, { id: "8888888888888888888", kind: "policy", reset_type: null, scope: "paid plans",
    announced_at: new Date(now - 60_000).toISOString(), text, author: "ClaudeDevs",
    url: "https://x.com/ClaudeDevs/status/8888888888888888888", verification: "provisional" });

  const after = computeStats(allResets(db), now);
  assert.deepEqual(
    [after.total, after.last_reset_at, after.avg_interval_days, after.longest_wait_days],
    [before.total, before.last_reset_at, before.avg_interval_days, before.longest_wait_days],
    "a ceiling change must not touch any reset statistic");

  const html = page(db, now);
  assert.ok(html.includes(esc(text)), "it is still preserved in the announcements log");
  assert.match(html, /log-item-kind--policy/);

  const today = new Date(now).toISOString().slice(0, 10);
  assert.equal(buildCalendar(allResets(db), { now }).cells.find((c) => c.date === today).count, 0,
    "and it must not draw a calendar square");
});

test("the page still renders with no data at all", () => {
  const html = renderPage({ events: [], resets: [], stats: computeStats([]),
                            calendar: buildCalendar([]), vapidKey: null });
  assert.match(html, /no resets tracked yet/);
  assert.match(html, /Nothing tracked yet/);
});
