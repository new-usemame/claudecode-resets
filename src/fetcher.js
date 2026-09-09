import { classify } from "./classify.js";
import { hydrate } from "./hydrate.js";
import { viaTimeline, viaSearch } from "./discovery.js";
import { insertEvent, setKv, getKv } from "./store.js";
import { announce } from "./notify.js";

/**
 * Watches the public X timelines of the accounts that announce Claude Code resets.
 *
 * Two stages, deliberately separated:
 *   discovery  — X's public syndication timeline tells us which post ids are new.
 *   hydration  — every candidate is then re-fetched from X's own tweet endpoint, and
 *                only X's returned text / created_at / author are stored.
 * A post that cannot be hydrated is NOT stored. We would rather show a shorter,
 * fully-sourced history than a longer one we cannot stand behind.
 *
 * When discovery breaks we say so loudly: consecutive failures raise an alert (log,
 * /healthz, and an optional webhook) instead of quietly returning nothing forever.
 */
const ACCOUNTS = (process.env.WATCH_ACCOUNTS ?? "ClaudeDevs").split(",").map((s) => s.trim()).filter(Boolean);
const INTERVAL_MS = Number(process.env.FETCH_INTERVAL_MS ?? 10 * 60_000);
// Alerting is on DISCOVERY STALENESS, not on consecutive tick failures. Most ticks
// legitimately find nothing new: X's timeline 429s and the search route is
// deliberately throttled to once an hour, so counting those as failures would page
// about a system that is working exactly as designed. What actually matters is how
// long it has been since ANY route last gave us a look at the account.
const STALE_AFTER_MS = Number(process.env.FETCH_STALE_AFTER_MS ?? 3 * 60 * 60_000);
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL ?? "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BRAVE_KEY = process.env.BRAVE_API_KEY ?? "";
// The search index is a shared, metered resource. It is only consulted when X's own
// timeline refuses us, and then at most once an hour, which keeps the tracker alive
// through a 429 without spending someone else's quota every ten minutes.
const SEARCH_MIN_INTERVAL_MS = Number(process.env.SEARCH_MIN_INTERVAL_MS ?? 60 * 60_000);
let lastSearchAt = 0;

/** X snowflake ids carry their own creation time — a cheap sanity check on hydration. */
export function snowflakeToDate(id) {
  return new Date(Number((BigInt(id) >> 22n) + 1288834974657n));
}

/**
 * Merge every discovery route. A tick only counts as failed when EVERY route failed —
 * one route going dark costs freshness, not coverage.
 */
async function discover(handle) {
  const merged = new Map();
  const errors = [];

  try {
    for (const p of await viaTimeline(handle)) merged.set(p.id, p);
  } catch (err) {
    errors.push(`timeline: ${err.message}`);
  }

  const searchDue = Date.now() - lastSearchAt >= SEARCH_MIN_INTERVAL_MS;
  if (!merged.size && BRAVE_KEY && searchDue) {
    lastSearchAt = Date.now();
    try {
      for (const p of await viaSearch([handle], BRAVE_KEY)) merged.set(p.id, p);
      console.log(`[fetcher] ${handle}: timeline unavailable, ${merged.size} candidate(s) via search`);
    } catch (err) {
      errors.push(`search: ${err.message}`);
    }
  } else if (!merged.size && !searchDue) {
    errors.push("search: throttled");
  }

  if (!merged.size) throw new Error(errors.join(" | ") || "no candidates from any route");
  if (errors.length) console.warn(`[fetcher] ${handle}: partial discovery — ${errors.join(" | ")}`);
  return [...merged.values()];
}

async function raiseAlert(db, handle, message, staleMinutes) {
  const line = `[fetcher] ALERT ${handle}: ${message} — no successful discovery for ${staleMinutes}m`;
  console.error(line);
  setKv(db, `fetch:alert:${handle}`, `${new Date().toISOString()} ${message} stale=${staleMinutes}m`);
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "text/plain", title: "claudecode-resets fetcher blind" },
      body: line,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[fetcher] alert webhook failed", err.message);
  }
}

/** Health of every watched source, for /healthz and for a human reading logs. */
export function fetcherHealth(db, now = Date.now()) {
  return ACCOUNTS.map((handle) => {
    const lastSuccess = getKv(db, `fetch:ok:${handle}`);
    const staleMs = lastSuccess ? now - Date.parse(lastSuccess) : null;
    return {
      account: handle,
      last_success: lastSuccess,
      last_error: getKv(db, `fetch:err:${handle}`),
      minutes_since_discovery: staleMs == null ? null : Math.round(staleMs / 60_000),
      stale_after_minutes: Math.round(STALE_AFTER_MS / 60_000),
      // Never seen a success yet is a starting state, not an outage.
      alerting: staleMs != null && staleMs > STALE_AFTER_MS,
    };
  });
}

/** One pass over every watched account. Returns the events it newly stored. */
export async function fetchOnce(db) {
  const stored = [];

  for (const handle of ACCOUNTS) {
    let candidates;
    try {
      candidates = await discover(handle);
      setKv(db, `fetch:ok:${handle}`, new Date().toISOString());
    } catch (err) {
      setKv(db, `fetch:err:${handle}`, `${new Date().toISOString()} ${err.message}`);
      const [health] = fetcherHealth(db).filter((h) => h.account === handle);
      if (health?.alerting) {
        await raiseAlert(db, handle, err.message, health.minutes_since_discovery);
      } else {
        console.warn(`[fetcher] ${handle}: ${err.message} ` +
                     `(last discovery ${health?.minutes_since_discovery ?? "never"}m ago)`);
      }
      continue;
    }

    for (const candidate of candidates) {
      // Screening on the discovery hint keeps us from hydrating the whole timeline;
      // a candidate with no usable hint is hydrated anyway rather than dropped.
      if (candidate.hint && candidate.hint.length > 40 && !classify(candidate.hint)) continue;

      let post;
      try {
        post = await hydrate(candidate.id, candidate.handle ?? handle);
      } catch (err) {
        console.warn(`[fetcher] refusing to store ${candidate.id}: ${err.message}`);
        continue;
      }

      // Classify X's canonical text, not the timeline's rendering of it.
      const verdict = classify(post.text);
      if (!verdict) continue;

      // The id encodes its own timestamp; a wide disagreement means something is off.
      const drift = Math.abs(snowflakeToDate(post.id) - new Date(post.announced_at));
      if (drift > 60_000) {
        console.warn(`[fetcher] refusing ${post.id}: timestamp drift ${Math.round(drift / 1000)}s`);
        continue;
      }

      const event = {
        id: post.id,
        kind: verdict.kind,
        reset_type: verdict.reset_type,
        scope: verdict.scope,
        announced_at: post.announced_at,
        text: post.text,
        author: post.author ?? handle,
        url: `https://x.com/${post.author ?? handle}/status/${post.id}`,
        verification: "provisional",
      };
      if (insertEvent(db, event)) {
        console.log(`[fetcher] new ${event.kind}${event.reset_type ? `/${event.reset_type}` : ""} ` +
                    `${event.id} @${event.author} via ${post.via}`);
        stored.push(event);
      }
    }
  }

  for (const e of stored) {
    try { await announce(db, e); }
    catch (err) { console.error("[fetcher] announce failed", e.id, err.message); }
  }
  return stored;
}

export function startFetcher(db) {
  const tick = () => fetchOnce(db).catch((e) => console.error("[fetcher] tick failed", e));
  setTimeout(tick, 15_000);   // keep boot fast; don't hammer X on every redeploy
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  console.log(`[fetcher] watching ${ACCOUNTS.join(", ")} every ${Math.round(INTERVAL_MS / 60000)}m`);
  return timer;
}

if (process.argv.includes("--once")) {
  const { openDb } = await import("./store.js");
  const db = openDb();
  console.log(`stored ${(await fetchOnce(db)).length} new event(s)`);
  console.log(JSON.stringify(fetcherHealth(db), null, 1));
  process.exit(0);
}
