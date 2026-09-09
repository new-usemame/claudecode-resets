# claudecode-resets.com

An independent tracker for **Claude Code usage-limit resets** — when Anthropic flushes
5-hour and weekly limits, how long it's been since the last one, and every announcement
kept on the record.

Live at **https://claudecode-resets.com**.

Not affiliated with, endorsed by, or operated by Anthropic. It just watches the public
account that announces the resets, so you don't have to.

## Where the data comes from

Resets are announced on X by [@ClaudeDevs](https://x.com/ClaudeDevs) — Anthropic's
official account for developers — and occasionally by Claude Code team members. That is
the source. There is no scraping behind a login, no API key, and no third-party dataset
in the chain.

Every entry is stored with:

| field | meaning |
| --- | --- |
| `announced_at` | UTC timestamp **from the post itself**, not from when we noticed it |
| `text` | the post's verbatim words |
| `source.url` | a link to the original post |
| `source.author` | the account that posted it |
| `scope` | who the announcement covered |
| `kind` | `reset` (counters flushed) or `policy` (ceiling moved, nothing flushed) |
| `reset_type` | `full` (everyone) or `partial` (one plan tier, or only affected users) |

A **policy** entry is kept in the announcements log because it is genuinely useful, but
it never counts toward the reset total, the average wait, or a calendar square. Raising
a limit is not the same as resetting one, and folding the two together would quietly
inflate every number on the page.

### Certainty over volume

Nothing ships that we cannot substantiate. Hydration goes to X's own public syndication
endpoint (`cdn.syndication.twimg.com/tweet-result`), with FixTweet as a fallback, and a
candidate that no route can return is **not stored** — the fetcher logs the refusal and
moves on. One announcement that a competing tracker lists is deliberately absent here
because the post now 404s at the source and we could not verify it.

You can check the whole dataset yourself, any time:

```bash
node scripts/verify-sources.mjs
```

It re-fetches all 15 entries from X and compares author, timestamp and verbatim text,
exiting non-zero on any mismatch. As of the last run: **15/15 verified**.

## How the live tracker keeps up

`src/fetcher.js` polls every 10 minutes:

1. **discover** — X's public syndication timeline lists recent post ids
2. **screen** — `src/classify.js` decides whether the text is a reset, a limit change, or neither
3. **hydrate** — the candidate is re-fetched from X and only X's own text/timestamp/author are kept
4. **sanity-check** — the post's snowflake id must agree with its timestamp
5. **store & notify** — new resets go out over browser push and email

A newly detected event is stored as `provisional`. `data/resets.json` is the curated
history, re-applied on every boot, so a human correction in git always wins over
whatever the classifier guessed.

### How fresh is it, honestly

Step 1 is the weak link, and it is worth being straight about. X's public timeline
endpoint rate-limits hard by IP — it has returned 429 on every address I have tried,
including the production host — so most of the time discovery falls back to a search
index, which is checked at most every 15 minutes and only after the timeline refuses.
A search index also takes its own time to see a brand-new post.

So: an announcement usually appears here within the hour, not within the minute, and a
run of bad luck can make it longer. Hydration and verification are exact; discovery
latency is the honest caveat. If you need the instant signal, follow
[@ClaudeDevs](https://x.com/ClaudeDevs) directly — that is the source, and this site
has never pretended otherwise.

If discovery breaks — X changes the endpoint, rate-limits us, whatever — the fetcher
**says so**: consecutive failures raise an alert to the log, to `ALERT_WEBHOOK_URL`, and
to `/healthz`, which starts returning 503. A tracker that silently stops tracking is
worse than one that is honestly down.

## Public API

Free, no key, CORS open. Docs at [`/api/docs`](https://claudecode-resets.com/api/docs).

```
GET /api/v1/status                     latest reset + aggregate stats
GET /api/v1/resets?limit=50&kind=all   announcements, newest first
GET /rss.xml                           the same as a feed
GET /healthz                           source health
```

## Running it

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # classifier tests, incl. every curated entry
npm run fetch:once        # one fetch pass, then exit
```

| env | purpose |
| --- | --- |
| `PORT` | listen port (default 3000) |
| `DATA_DIR` | where `resets.db` lives — the Railway volume mount in production |
| `SITE_ORIGIN` | canonical origin, used in metadata and email links |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web push; push is hidden if unset |
| `RESEND_API_KEY` / `MAIL_FROM` | email alerts; email is disabled if unset |
| `WATCH_ACCOUNTS` | comma-separated handles to watch (default `ClaudeDevs`) |
| `FETCH_INTERVAL_MS` | poll interval (default 600000) |
| `BRAVE_API_KEY` | Brave Search key for the fallback discovery route |
| `SEARCH_MIN_INTERVAL_MS` | floor between search fallbacks (default 900000) |
| `FETCH_STALE_AFTER_MS` | how long with no successful discovery before alerting (default 3h) |
| `ALERT_WEBHOOK_URL` | POSTed a line of text when a source goes blind |
| `TELEGRAM_URL` | shows the Telegram button when a channel exists |
| `FETCHER` | `off` to run the web server without polling |

Node 22.5+ (it uses the built-in `node:sqlite`). One runtime dependency, `web-push`.

## Credits

The layout, type scale and colour system are a deliberate one-to-one remake of
[codex-resets.com](https://codex-resets.com), which does this for OpenAI Codex and did
it first. Baloo 2 is used under the SIL Open Font License 1.1.

MIT licensed. Built by [new-usemame](https://github.com/new-usemame).
