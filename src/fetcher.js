import { classify } from "./classify.js";
import { hydrate } from "./hydrate.js";
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
const ALERT_AFTER = Number(process.env.FETCH_ALERT_AFTER ?? 3);
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL ?? "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SYNDICATION = (handle) =>
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;

/** X snowflake ids carry their own creation time — a cheap sanity check on hydration. */
export function snowflakeToDate(id) {
  return new Date(Number((BigInt(id) >> 22n) + 1288834974657n));
}

async function discover(handle) {
  const res = await fetch(SYNDICATION(handle), {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`syndication timeline ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("syndication timeline returned no __NEXT_DATA__");
  const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries ?? [];
  const tweets = entries
    .map((e) => e?.content?.tweet)
    .filter((t) => t?.id_str && !t.retweeted_status && !t.in_reply_to_status_id_str);
  if (!tweets.length) throw new Error("syndication timeline returned zero posts");
  return tweets.map((t) => ({ id: t.id_str, text: t.full_text ?? t.text ?? "" }));
}

async function raiseAlert(db, handle, message, streak) {
  const line = `[fetcher] ALERT ${handle}: ${message} (${streak} consecutive failures)`;
  console.error(line);
  setKv(db, `fetch:alert:${handle}`, `${new Date().toISOString()} ${message} x${streak}`);
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
export function fetcherHealth(db) {
  return ACCOUNTS.map((handle) => ({
    account: handle,
    last_success: getKv(db, `fetch:ok:${handle}`),
    last_error: getKv(db, `fetch:err:${handle}`),
    failure_streak: Number(getKv(db, `fetch:streak:${handle}`) ?? 0),
    alerting: Number(getKv(db, `fetch:streak:${handle}`) ?? 0) >= ALERT_AFTER,
  }));
}

/** One pass over every watched account. Returns the events it newly stored. */
export async function fetchOnce(db) {
  const stored = [];

  for (const handle of ACCOUNTS) {
    let candidates;
    try {
      candidates = await discover(handle);
      setKv(db, `fetch:ok:${handle}`, new Date().toISOString());
      setKv(db, `fetch:streak:${handle}`, 0);
    } catch (err) {
      const streak = Number(getKv(db, `fetch:streak:${handle}`) ?? 0) + 1;
      setKv(db, `fetch:streak:${handle}`, streak);
      setKv(db, `fetch:err:${handle}`, `${new Date().toISOString()} ${err.message}`);
      if (streak >= ALERT_AFTER) await raiseAlert(db, handle, err.message, streak);
      else console.warn(`[fetcher] ${handle}: ${err.message} (streak ${streak})`);
      continue;
    }

    for (const candidate of candidates) {
      // Screen on the timeline text first so we only hydrate plausible announcements.
      if (!classify(candidate.text)) continue;

      let post;
      try {
        post = await hydrate(candidate.id, handle);
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
