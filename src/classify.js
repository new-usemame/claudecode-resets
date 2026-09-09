/**
 * Decide whether an announcement flushed usage counters, moved the ceiling, or is
 * neither.
 *
 * Context matters: the fetcher only ever feeds this posts from @ClaudeDevs and the
 * Claude Code team, so the text does NOT have to name Claude — "We've reset 5-hour
 * and weekly rate limits for all users." is a complete announcement on that account.
 * Requiring a product keyword here silently dropped real resets.
 *
 * Deliberately conservative in the other direction: anything it is not sure about
 * comes back as null, and everything it does emit is stored `provisional` until a
 * human promotes it into data/resets.json (which the store re-applies as `curated`).
 */

// Past-tense flush of a usage counter. The verb has to be doing something to limits.
const RESET_SIGNAL =
  /\b(?:we(?:'ve|’ve| have)?\s+reset|we(?:'re|’re| are)?\s+resett?ing|resetting|reset)\s+(?:the\s+|all\s+|everyone'?s?\s+|your\s+)?(?:5-?hour|weekly|usage|rate|limits?|everyone|all\b)/i;

const LIMIT_NOUN = /\b(?:rate limits?|usage limits?|weekly limits?|5-?hour limits?|limits?|usage|quotas?)\b/i;

// Ceiling moved, nothing flushed.
const POLICY_SIGNAL =
  /\b(?:raising|raise|increas(?:e|ing)|doubl(?:e|ing)|extend(?:ing|ed)?|keeping|higher|permanently|lifting|removing (?:the )?peak)\b/i;

// Talks about limits, but is not an event we track.
const NEGATIVE = [
  /\b(?:will|would|should|may|might|going to)\s+reset\b/i,   // future/hypothetical
  /\blimits?\s+reset\s+(?:every|at|on|automatically)\b/i,     // describing the normal cycle
  /\bautomatically resets?\b/i,
  /\bpassword reset\b/i,
  /\bhow (?:do|to|does)\b/i,                                  // support/FAQ voice
  /\breset your (?:password|account)\b/i,
];

const ALL_SCOPE = /\b(?:everyone|all users|all subscribers|all plans|across all plans|every paid)\b/i;
const SUBSET_SCOPE =
  /\b(?:pro and max|on (?:a )?(?:claude )?max plan|max plans?|pro plans?|team|enterprise|affected|impacted|some (?:of )?(?:you|users)|eligible)\b/i;

const PRODUCT = /\b(?:claude code|claude|opus|sonnet|haiku|fable|subscription)\b/i;

export function classify(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  if (NEGATIVE.some((re) => re.test(t))) return null;
  if (!LIMIT_NOUN.test(t)) return null;

  if (RESET_SIGNAL.test(t)) {
    // Scope is read from the sentence that actually announces the reset. Judging the
    // whole post mis-reads sentences like "some of you reported ... we've reset usage
    // limits for all subscribers" — "some of you" describes the reporters, not the
    // people who got the reset.
    const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    const clause = sentences.find((s) => RESET_SIGNAL.test(s)) ?? t;
    const scoped = SUBSET_SCOPE.test(clause) || ALL_SCOPE.test(clause) ? clause : t;
    const subset = SUBSET_SCOPE.test(scoped);
    const all = ALL_SCOPE.test(scoped);
    const reset_type = subset ? "partial" : "full";
    return {
      kind: "reset",
      reset_type,
      scope: subset ? "subset" : "all",
      // Explicit audience, or a product word, means we read it the way a human would.
      confidence: all || subset || PRODUCT.test(t) ? "high" : "medium",
    };
  }

  if (POLICY_SIGNAL.test(t) && /\blimits?\b/i.test(t)) {
    return { kind: "policy", reset_type: null, scope: "paid plans", confidence: "medium" };
  }

  return null;
}
