import { DAY_MS, utcDay, round1 } from "./util.js";

/** Sunday (UTC) of the week containing `d`. */
export function weekStart(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x;
}

/**
 * Totals for the three stat tiles. Only `kind = 'reset'` rows count — a policy
 * change moves the ceiling without flushing anyone's counters, so folding it in
 * would quietly inflate every number on the page.
 */
export function computeStats(resets, now = Date.now()) {
  const asc = [...resets].sort((a, b) => a.announced_at.localeCompare(b.announced_at));
  const times = asc.map((r) => new Date(r.announced_at).getTime());
  const total = asc.length;
  const last = times.at(-1) ?? null;

  let avgIntervalDays = null;
  let longestWaitDays = null;
  if (times.length >= 2) {
    avgIntervalDays = round1((times.at(-1) - times[0]) / (times.length - 1) / DAY_MS);
    let longest = 0;
    for (let i = 1; i < times.length; i++) longest = Math.max(longest, times[i] - times[i - 1]);
    longestWaitDays = round1(longest / DAY_MS);
  }
  // A drought in progress can be the longest wait on record; the reference counts it too.
  if (last != null) {
    const sinceLast = round1((now - last) / DAY_MS);
    if (longestWaitDays == null || sinceLast > longestWaitDays) longestWaitDays = sinceLast;
  }

  return {
    total,
    last_reset_at: last == null ? null : new Date(last).toISOString(),
    days_since_last: last == null ? null : Math.floor((now - last) / DAY_MS),
    avg_interval_days: avgIntervalDays,
    longest_wait_days: longestWaitDays,
  };
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * GitHub-style contribution grid for the last `weeks` weeks, ending today (UTC).
 * Column 1 is the Sunday `weeks - 1` weeks before the current week's Sunday;
 * nothing after today is drawn, exactly as the reference does it.
 */
export function buildCalendar(resets, { weeks = 26, now = Date.now() } = {}) {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const firstSunday = weekStart(today);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - weeks * 7);

  const byDay = new Map();
  for (const r of resets) {
    const day = utcDay(r.announced_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }

  const cells = [];
  const months = [];
  let seenMonth = null;
  let column = 0;

  for (let cursor = new Date(firstSunday); cursor <= today; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dow = cursor.getUTCDay();
    if (dow === 0) {
      column += 1;
      const m = cursor.getUTCMonth();
      if (m !== seenMonth) { months.push({ column, label: MONTHS[m] }); seenMonth = m; }
    }
    const day = utcDay(cursor);
    const hits = byDay.get(day) ?? [];
    // A day with both kinds reads as the stronger one.
    const type = hits.some((h) => h.reset_type === "full") ? "full"
               : hits.length ? "partial" : null;
    cells.push({
      date: day,
      column: Math.max(1, column),
      row: dow + 2,               // row 1 holds the month labels
      count: hits.length,
      type,
      href: hits[0]?.url ?? null,
      snippet: hits[0] ? hits[0].text.slice(0, 120) : "",
    });
  }
  return { columns: Math.max(1, column), cells, months, weeks };
}
