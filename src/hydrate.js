/**
 * Turn an X status id into the post's own words.
 *
 * Primary route is X's own public syndication endpoint — the one that backs embedded
 * tweets. It needs no login and no API key, and it returns the canonical `text`,
 * `created_at` and author, so a stored entry is X's account of the post rather than
 * ours or a third party's. FixTweet is kept only as a fallback for when that endpoint
 * is unavailable, and every hydration records which route produced it.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const stripTrailingMediaLink = (t) => String(t ?? "").replace(/\s*https:\/\/t\.co\/\w+\s*$/, "").trim();

async function viaSyndication(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&lang=en&token=a`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`syndication ${res.status}`);
  const d = await res.json();
  if (!d?.text || !d?.created_at) throw new Error("syndication payload missing text/created_at");
  return {
    id,
    text: stripTrailingMediaLink(d.text),
    author: d.user?.screen_name ?? null,
    announced_at: new Date(d.created_at).toISOString(),
    via: "x-syndication",
  };
}

async function viaFixTweet(id, handleHint) {
  const handle = handleHint ?? "i";
  const res = await fetch(`https://api.fxtwitter.com/${handle}/status/${id}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`fxtwitter ${res.status}`);
  const t = (await res.json())?.tweet;
  if (!t?.text || !t?.created_timestamp) throw new Error("fxtwitter payload missing text/created_timestamp");
  return {
    id,
    text: stripTrailingMediaLink(t.text),
    author: t.author?.screen_name ?? handleHint ?? null,
    announced_at: new Date(t.created_timestamp * 1000).toISOString(),
    via: "fxtwitter",
  };
}

/**
 * @returns {Promise<{id,text,author,announced_at,via}>}
 * @throws when NO route could produce the post — the caller must not store a guess.
 */
export async function hydrate(id, handleHint) {
  const errors = [];
  for (const route of [() => viaSyndication(id), () => viaFixTweet(id, handleHint)]) {
    try { return await route(); }
    catch (err) { errors.push(err.message); }
  }
  throw new Error(`could not hydrate ${id}: ${errors.join("; ")}`);
}
