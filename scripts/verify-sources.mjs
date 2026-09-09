#!/usr/bin/env node
/**
 * Re-checks every curated entry in data/resets.json against the original X post.
 *
 * This is the data-certainty gate: an entry is only allowed to ship if X itself still
 * returns the same author, the same timestamp, and the same words. Run it any time —
 * it talks only to public endpoints and needs no credentials.
 *
 *   node scripts/verify-sources.mjs            # verify
 *   node scripts/verify-sources.mjs --stamp    # verify, then record the result in the file
 *
 * Exit code is non-zero if any entry fails, so CI can hold the line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { hydrate } from "../src/hydrate.js";

const SEED = new URL("../data/resets.json", import.meta.url);
const doc = JSON.parse(readFileSync(SEED, "utf8"));
const stamp = process.argv.includes("--stamp");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
let failures = 0;

for (const e of doc.events) {
  process.stdout.write(`${e.id} … `);
  try {
    const post = await hydrate(e.id, e.source.author);
    const problems = [];
    if (norm(post.text) !== norm(e.text)) problems.push("text");
    if ((post.author ?? "").toLowerCase() !== e.source.author.toLowerCase()) problems.push("author");
    if (post.announced_at.slice(0, 19) !== e.announced_at.slice(0, 19)) problems.push("announced_at");

    if (problems.length) {
      failures += 1;
      console.log(`MISMATCH (${problems.join(", ")})`);
      if (problems.includes("announced_at")) console.log(`   x=${post.announced_at}  ours=${e.announced_at}`);
      if (problems.includes("text")) console.log(`   x=${JSON.stringify(post.text.slice(0, 120))}`);
    } else {
      console.log(`ok  @${post.author}  ${post.announced_at}  via ${post.via}`);
      if (stamp) {
        e.verified_at = new Date().toISOString();
        e.verified_via = post.via;
      }
    }
  } catch (err) {
    failures += 1;
    console.log(`UNVERIFIABLE — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 800));   // one request at a time, politely
}

if (stamp && !failures) {
  doc.verification = {
    method: "Each entry re-fetched from X's public syndication endpoint and compared on author, timestamp and verbatim text.",
    last_run: new Date().toISOString(),
    entries_verified: doc.events.length,
  };
  writeFileSync(SEED, `${JSON.stringify(doc, null, 2)}\n`);
  console.log("\nstamped data/resets.json");
}

console.log(`\n${doc.events.length - failures}/${doc.events.length} entries verified against the original post`);
process.exit(failures ? 1 : 0);
