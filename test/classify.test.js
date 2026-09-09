import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify.js";
import { readFileSync } from "node:fs";

// Every one of these is the VERBATIM text of a real @ClaudeDevs / Claude Code team
// post, so a regression here is a regression against reality, not against a fixture.
const seed = JSON.parse(readFileSync(new URL("../data/resets.json", import.meta.url)));

test("classifies every curated announcement the same way a human did", () => {
  for (const e of seed.events) {
    const got = classify(e.text);
    assert.ok(got, `expected a classification for ${e.id}: ${e.text.slice(0, 60)}`);
    assert.equal(got.kind, e.kind, `kind mismatch for ${e.id}`);
    if (e.kind === "reset") assert.equal(got.reset_type, e.reset_type, `reset_type mismatch for ${e.id}`);
  }
});

test("a reset with no product word still counts (the account is the context)", () => {
  const got = classify("We've reset 5-hour and weekly rate limits for all users.");
  assert.deepEqual({ kind: got.kind, reset_type: got.reset_type }, { kind: "reset", reset_type: "full" });
});

test("an incident-scoped reset is partial, not full", () => {
  const got = classify("This is fixed, and we're resetting 5-hour and weekly limits for everyone affected.");
  assert.equal(got.kind, "reset");
  assert.equal(got.reset_type, "partial");
});

test("describing the normal reset cycle is not an announcement", () => {
  assert.equal(classify("Your usage limits reset every 5 hours."), null);
  assert.equal(classify("Limits will reset at the start of your next window."), null);
  assert.equal(classify("How do usage and length limits work?"), null);
});

test("unrelated product news is not an announcement", () => {
  assert.equal(classify("Claude Code v2.3 ships faster diffs and a new /usage command."), null);
  assert.equal(classify("We shipped subagents today. Enjoy!"), null);
});

test("a ceiling change is policy, never a reset", () => {
  const got = classify("Starting September 14, we're permanently raising standard weekly limits in Claude Code by 25% for Pro, Max, Team, and seat-based Enterprise plans.");
  assert.equal(got.kind, "policy");
  assert.equal(got.reset_type, null);
});

test("empty and junk input is rejected", () => {
  assert.equal(classify(""), null);
  assert.equal(classify(null), null);
  assert.equal(classify("gm"), null);
});
