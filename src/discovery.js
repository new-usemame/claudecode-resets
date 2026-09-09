/**
 * Discovery: how we learn that a status id EXISTS. Nothing here is ever published —
 * a discovered id is only a lead, and every field that reaches the site comes from
 * hydrating that id against X itself (src/hydrate.js).
 *
 * Two routes, because neither is reliable alone:
 *   timeline — X's public syndication timeline. Complete and fast when it answers,
 *              but it rate-limits hard by IP and has 429'd consistently from both a
 *              home connection and Railway, so it cannot be the only route.
 *   search   — the Brave Search API, asked for recent posts from the watched accounts.
 *              Slower to index a brand-new post, but it answers when X will not.
 *
 * Both are tried every tick and their results are merged, so one going dark degrades
 * freshness rather than stopping the tracker.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STATUS_RE = /(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/;

export async function viaTimeline(handle) {
  const res = await fetch(
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
    { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`syndication timeline ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("syndication timeline returned no __NEXT_DATA__");
  const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries ?? [];
  const posts = entries
    .map((e) => e?.content?.tweet)
    .filter((t) => t?.id_str && !t.retweeted_status && !t.in_reply_to_status_id_str)
    .map((t) => ({ id: t.id_str, handle: t.user?.screen_name ?? handle, hint: t.full_text ?? t.text ?? "" }));
  if (!posts.length) throw new Error("syndication timeline returned zero posts");
  return posts;
}

export async function viaSearch(handles, apiKey) {
  if (!apiKey) throw new Error("no BRAVE_API_KEY configured");
  const watched = new Set(handles.map((h) => h.toLowerCase()));
  const queries = [
    `${handles[0]} reset 5-hour and weekly rate limits`,
    `site:x.com ${handles[0]} status reset limits`,
    `"we've reset" usage limits Claude Code x.com`,
  ];
  const found = new Map();
  const errors = [];
  for (const q of queries) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "20" })}`;
      const res = await fetch(url, {
        headers: { accept: "application/json", "x-subscription-token": apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { errors.push(`brave ${res.status}`); continue; }
      for (const r of (await res.json())?.web?.results ?? []) {
        const m = STATUS_RE.exec(r.url ?? "");
        if (!m) continue;
        const [, handle, id] = m;
        if (!watched.has(handle.toLowerCase())) continue;
        // Brave's snippet is a lead only; the hint is never stored.
        found.set(id, { id, handle, hint: r.description ?? r.title ?? "" });
      }
    } catch (err) { errors.push(err.message); }
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!found.size && errors.length) throw new Error(`search found nothing: ${errors.join("; ")}`);
  return [...found.values()];
}
