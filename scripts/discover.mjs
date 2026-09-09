#!/usr/bin/env node
/**
 * Coverage sweep: ask a web index for posts that look like Claude Code reset
 * announcements, then hydrate every candidate from X and classify X's own words.
 *
 * Search is only ever a way to LEARN A STATUS ID. Nothing a search engine says about
 * a post is published — the text, timestamp and author always come from X.
 *
 *   BRAVE_API_KEY=... node scripts/discover.mjs
 */
import { readFileSync } from "node:fs";
import { hydrate } from "../src/hydrate.js";
import { classify } from "../src/classify.js";

// Accept the key directly, or the vault record the broker injects as $SECRET, so the
// value never has to pass through a shell variable or argv.
function braveKey() {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY.trim();
  const raw = process.env.SECRET;
  if (!raw) return null;
  try { return (JSON.parse(raw).api_key ?? "").trim() || null; } catch { return raw.trim() || null; }
}
const KEY = braveKey();
if (!KEY) {
  console.error('no key: run under `secret exec "Brave Search API (research-mcp)" -- node scripts/discover.mjs`');
  process.exit(2);
}

const WATCHED = new Set(["claudedevs", "lydiahallie", "_catwu", "bcherny", "adamwolff"]);
const QUERIES = [
  "ClaudeDevs reset 5-hour and weekly rate limits",
  "site:x.com ClaudeDevs status reset limits",
  "ClaudeDevs \"we've reset\" usage limits Claude Code",
  "site:x.com ClaudeDevs weekly limits reset everyone",
  "Anthropic Claude Code reset usage limits announcement x.com",
  "\"reset\" \"weekly limits\" Claude Max plan x.com announcement",
];

const seed = JSON.parse(readFileSync(new URL("../data/resets.json", import.meta.url), "utf8"));
const known = new Set(seed.events.map((e) => e.id));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function brave(q) {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "20" })}`;
  const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": KEY } });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  return (await res.json())?.web?.results ?? [];
}

const candidates = new Map();
for (const q of QUERIES) {
  try {
    for (const r of await brave(q)) {
      const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/.exec(r.url ?? "");
      if (!m) continue;
      const [, handle, id] = m;
      if (!WATCHED.has(handle.toLowerCase())) continue;
      if (known.has(id)) continue;
      candidates.set(id, handle);
    }
  } catch (err) { console.warn(`query failed (${q}): ${err.message}`); }
  await sleep(1200);
}

console.log(`${candidates.size} unseen candidate(s) from watched accounts\n`);
const found = [];
for (const [id, handle] of candidates) {
  try {
    const post = await hydrate(id, handle);
    const verdict = classify(post.text);
    if (verdict) {
      found.push({ id, handle: post.author, ...verdict, announced_at: post.announced_at, text: post.text });
      console.log(`HIT  ${id} @${post.author} ${post.announced_at} ${verdict.kind}/${verdict.reset_type ?? "-"}`);
      console.log(`     ${post.text.replace(/\n+/g, " ").slice(0, 150)}`);
    } else {
      console.log(`--   ${id} @${post.author} not an announcement`);
    }
  } catch (err) {
    console.log(`??   ${id} unverifiable — ${err.message.slice(0, 70)}`);
  }
  await sleep(900);
}

console.log(`\n${found.length} new announcement(s) to review before adding to data/resets.json`);
