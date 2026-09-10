import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { openDb, allEvents, resets as allResets, REPO_ROOT, getKv, setKv } from "./store.js";
import { computeStats, buildCalendar } from "./stats.js";
import { renderPage, SITE } from "./render.js";
import { esc } from "./util.js";
import { vapidPublicKey, addPushSub, removePushSub } from "./notify.js";
import { startFetcher, fetcherHealth } from "./fetcher.js";

const PORT = Number(process.env.PORT || 3000);

/**
 * Hosts this deployment actually answers for. Used to decide whether a www host is
 * safe to redirect to its apex — never trust the Host header as a redirect target.
 */
const SERVED_HOSTS = new Set(
  [
    new URL(SITE.origin).hostname,
    ...String(process.env.SERVED_HOSTS ?? "claudecode-resets.com,claude-reset.com")
      .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  ],
);
const PUBLIC = join(REPO_ROOT, "public");
const db = openDb();

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".woff2": "font/woff2", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
};
// The public read-only API is meant to be called from anywhere; admin replies are
// not, so CORS is opt-in per response rather than blanket.
const sendJson = (res, code, obj, headers = {}) =>
  send(res, code, JSON.stringify(obj), {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    ...headers,
  });

const sendPrivateJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

/**
 * Small fixed-window limiter, per client and per action. There is no login here, so
 * without it /api/email/subscribe is a way to make this site send confirmation mail to
 * anyone, repeatedly, on someone else's say-so — and to burn the sending quota doing it.
 * Memory-only and per-instance on purpose: this is abuse dampening, not a quota system.
 */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    if (buckets.size > 10_000) {           // bound the map; drop whatever has expired
      for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    }
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** Best-effort client identity behind Railway's proxy. */
const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
  req.socket.remoteAddress || "unknown";

/** Constant-time compare so a wrong token cannot be found one byte at a time. */
function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const apiMeta = () => ({ api_version: "v1", generated_at: new Date().toISOString() });

const publicEvent = (e) => ({
  id: e.id,
  kind: e.kind,
  reset_type: e.reset_type,
  scope: e.scope,
  announced_at: e.announced_at,
  text: e.text,
  verification: e.verification,
  source: { type: "x_post", author: e.author, url: e.url },
});

async function readBody(req, limit = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return false;
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const body = await readFile(file);
    const immutable = rel.startsWith("fonts/");
    send(res, 200, body, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    });
    return true;
  } catch { return false; }
}

function rss(events) {
  const items = events.slice(0, 50).map((e) => `    <item>
      <title>${esc(e.kind === "reset" ? `Claude Code ${e.reset_type} reset` : "Claude Code limit change")}</title>
      <link>${esc(e.url)}</link>
      <guid isPermaLink="false">${esc(e.id)}</guid>
      <pubDate>${new Date(e.announced_at).toUTCString()}</pubDate>
      <description>${esc(e.text)}</description>
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(SITE.name)}</title>
  <link>${esc(SITE.origin)}/</link>
  <description>Claude Code usage-limit resets, as announced by @${esc(SITE.account)}.</description>
  <language>en</language>
${items}
</channel></rss>`;
}

const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "Claude Code Resets Public API",
    version: "1.0.0",
    description:
      "Read-only access to Claude Code usage-limit announcements tracked by claudecode-resets.com. " +
      "Independent project; not affiliated with Anthropic. Every entry links to the original public X post.",
  },
  servers: [{ url: SITE.origin }],
  paths: {
    "/api/v1/status": {
      get: {
        summary: "Get the current reset status",
        responses: { 200: { description: "Latest reset plus aggregate stats" } },
      },
    },
    "/api/v1/resets": {
      get: {
        summary: "List reset announcements",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          { name: "kind", in: "query", schema: { type: "string", enum: ["reset", "policy", "all"], default: "reset" } },
        ],
        responses: { 200: { description: "Announcements, newest first" } },
      },
    },
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // One canonical host. www is a real domain on the service (so it gets a
    // certificate rather than throwing a scary TLS error at anyone who types it),
    // but it redirects rather than serving the page twice.
    // The site answers on more than one domain. Strip www to that SAME domain's apex
    // rather than jumping to the canonical origin, so a visitor who typed one domain
    // is not silently moved to another one.
    //
    // The Host header is attacker-controlled, so the stripped host is only ever used
    // as a redirect target when it is one we actually serve. Without that check,
    // `Host: www.evil.com` turns this into an open redirect that sends visitors off
    // the site under our own domain's good name.
    //
    // /.well-known is never redirected: it is where ACME answers the HTTP-01
    // challenge, and bouncing it means the host can never get a certificate.
    const host = String(req.headers.host ?? "").split(":")[0].toLowerCase();
    if (host.startsWith("www.") && !path.startsWith("/.well-known/")) {
      const apex = host.slice(4);
      if (SERVED_HOSTS.has(apex)) {
        return send(res, 301, "", {
          location: `https://${apex}${req.url}`,
          "cache-control": "public, max-age=86400",
        });
      }
      // A www host we do not serve is not ours to redirect anywhere.
      return send(res, 404, "Not found");
    }

    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
    }

    if (path === "/healthz") {
      // Surfaces a blind fetcher rather than letting the site look healthy while the
      // history quietly stops growing.
      const sources = fetcherHealth(db);
      const blind = sources.some((s) => s.alerting);
      return sendJson(res, blind ? 503 : 200, {
        ok: !blind,
        events: allEvents(db).length,
        resets: allResets(db).length,
        sources,
      });
    }

    if (path === "/" && req.method === "GET") {
      const events = allEvents(db);
      const resets = allResets(db);
      const now = Date.now();
      const html = renderPage({
        events, resets,
        stats: computeStats(resets, now),
        calendar: buildCalendar(resets, { now }),
        vapidKey: vapidPublicKey(),
        now,
      });
      return send(res, 200, html, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      });
    }

    if (path === "/api/v1/status") {
      const resets = allResets(db);
      const stats = computeStats(resets);
      return sendJson(res, 200, {
        data: {
          latest_reset: resets[0] ? publicEvent(resets[0]) : null,
          stats: {
            total: stats.total,
            last_reset_at: stats.last_reset_at,
            days_since_last: stats.days_since_last,
            avg_interval_days: stats.avg_interval_days,
            longest_wait_days: stats.longest_wait_days,
          },
        },
        meta: apiMeta(),
      });
    }

    if (path === "/api/v1/resets") {
      const kind = url.searchParams.get("kind") ?? "reset";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const source = kind === "all" ? allEvents(db)
        : kind === "policy" ? allEvents(db).filter((e) => e.kind === "policy")
        : allResets(db);
      const page = source.slice(offset, offset + limit);
      return sendJson(res, 200, {
        data: page.map(publicEvent),
        pagination: { total: source.length, limit, offset, has_more: offset + page.length < source.length },
        meta: apiMeta(),
      });
    }

    if (path === "/api/openapi.json") return sendJson(res, 200, OPENAPI);

    if (path === "/api/docs") {
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>API — ${esc(SITE.name)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script>window.onload=()=>{window.ui=SwaggerUIBundle({dom_id:'#swagger-ui',url:'/api/openapi.json'})}</script>
</body></html>`, { "content-type": "text/html; charset=utf-8" });
    }

    if (path === "/rss.xml") {
      return send(res, 200, rss(allEvents(db)), { "content-type": "application/rss+xml; charset=utf-8" });
    }

    if (path === "/llms.txt") {
      const resets = allResets(db);
      const stats = computeStats(resets);
      return send(res, 200, `# ${SITE.name}

> Independent tracker for Claude Code usage-limit resets, sourced from @${SITE.account} and
> Claude Code team members on X. Not affiliated with Anthropic.

Answers: "how long since Anthropic last reset Claude Code limits?" and "how often does that happen?"

## Snapshot
- Last reset: ${stats.last_reset_at ?? "none tracked"}${resets[0] ? ` (${resets[0].reset_type}, ${resets[0].scope ?? "scope unrecorded"}) ${resets[0].url}` : ""}
- Resets tracked: ${stats.total}
- Mean gap between resets: ${stats.avg_interval_days ?? "n/a"} days
- Longest gap: ${stats.longest_wait_days ?? "n/a"} days
- Limit-policy changes tracked separately (not counted as resets): ${allEvents(db).length - resets.length}

## Machine-readable
- Latest + stats: ${SITE.origin}/api/v1/status
- All announcements: ${SITE.origin}/api/v1/resets?kind=all&limit=200
- Feed: ${SITE.origin}/rss.xml
- OpenAPI: ${SITE.origin}/api/openapi.json
- Source health: ${SITE.origin}/healthz

## What the fields mean
- kind "reset": usage counters were flushed. kind "policy": the ceiling moved, nothing was
  flushed — deliberately excluded from every reset statistic on this site.
- reset_type "full": everyone. "partial": one plan tier, or only users affected by an incident.
- announced_at: UTC, taken from the source post itself, not from when this site noticed it.
- verification "curated": reviewed by a human. "provisional": detected automatically, still
  sourced from the original post.

## Provenance
Every entry is re-fetched from X's own public endpoint and compared on author, timestamp and
verbatim text; anything that cannot be verified is not published. Re-runnable:
https://github.com/new-usemame/claudecode-resets (scripts/verify-sources.mjs, MIT).

## Caveat worth repeating
Discovery of brand-new posts depends on a search index, so an announcement typically appears
here within the hour rather than within the minute. For the instant signal follow ${SITE.accountUrl}.
`, { "content-type": "text/plain; charset=utf-8" });
    }

    if (path === "/robots.txt") {
      const self = SERVED_HOSTS.has(host) ? `https://${host}` : SITE.origin;
      return send(res, 200,
        `User-agent: *\nAllow: /\nSitemap: ${self}/sitemap.xml\n` +
        `# Machine-readable summary: ${self}/llms.txt\n`);
    }

    if (path === "/sitemap.xml") {
      // lastmod is the newest announcement: the homepage genuinely changes when one
      // lands, and a sitemap that claims otherwise trains crawlers to ignore it.
      const newest = allEvents(db)[0]?.announced_at ?? new Date().toISOString();
      const lastmod = newest.slice(0, 10);
      // A sitemap describes the host it is served from, not the canonical one. Listing
      // claude-reset.com URLs in claudecode-resets.com's sitemap is a cross-domain
      // submission that Search Console flags. The canonical <link> already tells Google
      // which host to prefer; the sitemap's job is just to enumerate this host's pages.
      const origin = SERVED_HOSTS.has(host) ? `https://${host}` : SITE.origin;
      const urls = [
        { loc: `${origin}/`, changefreq: "daily", priority: "1.0", lastmod },
        { loc: `${origin}/api/docs`, changefreq: "monthly", priority: "0.5" },
        { loc: `${origin}/sponsor`, changefreq: "monthly", priority: "0.3" },
      ];
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${esc(u.loc)}</loc>${u.lastmod ? `
    <lastmod>${u.lastmod}</lastmod>` : ""}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n")}
</urlset>`;
      return send(res, 200, body, {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
      });
    }

    if (path === "/api/push/key") return sendJson(res, 200, { key: vapidPublicKey() });

    // Operational endpoints for proving the notification path actually delivers.
    // Guarded by ADMIN_TOKEN; with no token set they are simply off.
    if (path.startsWith("/api/admin/")) {
      // Header only — a token in the query string ends up in every access log,
      // proxy trace and Referer header along the way.
      const token = process.env.ADMIN_TOKEN;
      if (!tokenMatches(req.headers["x-admin-token"], token)) {
        return sendPrivateJson(res, 404, { error: "not found" });
      }

      if (path === "/api/admin/subscribers") {
        return sendPrivateJson(res, 200, {
          push: db.prepare(`SELECT COUNT(*) n FROM push_subs`).get().n,
          email_pending: db.prepare(`SELECT COUNT(*) n FROM email_subs WHERE confirmed_at IS NULL`).get().n,
          email_confirmed: db.prepare(`SELECT COUNT(*) n FROM email_subs WHERE confirmed_at IS NOT NULL`).get().n,
          sources: fetcherHealth(db),
        });
      }

      if (path === "/api/admin/test-notify" && req.method === "POST") {
        const latest = allResets(db)[0];
        if (!latest) return sendPrivateJson(res, 409, { error: "no reset to announce" });
        // A test must not consume the real event's once-per-event guard, so it
        // announces under a throwaway id and leaves the live record untouched.
        const { announce } = await import("./notify.js");
        const result = await announce(db, { ...latest, id: `test-${Date.now()}` });
        return sendPrivateJson(res, 200, { announced: latest.id, delivered: result });
      }

      if (path === "/api/admin/fetch-now" && req.method === "POST") {
        const { fetchOnce } = await import("./fetcher.js");
        const stored = await fetchOnce(db);
        return sendPrivateJson(res, 200, { stored: stored.map((e) => e.id), sources: fetcherHealth(db) });
      }

      return sendPrivateJson(res, 404, { error: "not found" });
    }

    if (path === "/api/push/subscribe" && req.method === "POST") {
      if (!rateLimit(`push:${clientIp(req)}`, 20, 60 * 60_000)) {
        return sendJson(res, 429, { error: "too many requests" });
      }
      const sub = JSON.parse(await readBody(req));
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return sendJson(res, 400, { error: "invalid subscription" });
      }
      addPushSub(db, sub);
      return sendJson(res, 201, { ok: true });
    }

    if (path === "/api/push/unsubscribe" && req.method === "POST") {
      const { endpoint } = JSON.parse(await readBody(req));
      removePushSub(db, endpoint);
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/email/subscribe" && req.method === "POST") {
      if (!rateLimit(`email:${clientIp(req)}`, 3, 60 * 60_000)) {
        return sendJson(res, 429, { state: "error", message: "Too many attempts. Try again later." });
      }
      const { email } = JSON.parse(await readBody(req));
      const clean = String(email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(clean) || clean.length > 254) {
        return sendJson(res, 400, { state: "error", message: "That doesn't look like an email address." });
      }
      // A second window keyed on the address, so one address cannot be mailed
      // repeatedly from many clients.
      if (!rateLimit(`emailaddr:${clean}`, 2, 60 * 60_000)) {
        return sendJson(res, 429, { state: "error", message: "We already sent that address a link. Check your inbox." });
      }
      const { requestEmailConfirmation } = await import("./notify.js");
      const state = await requestEmailConfirmation(db, clean);
      return sendJson(res, 202, state);
    }

    if (path === "/api/email/confirm") {
      const token = url.searchParams.get("token") ?? "";
      const row = db.prepare(`SELECT email FROM email_subs WHERE token = ?`).get(token);
      if (!row) return send(res, 404, "That confirmation link is no longer valid.");
      db.prepare(`UPDATE email_subs SET confirmed_at = datetime('now') WHERE token = ?`).run(token);
      return send(res, 200,
        `<!doctype html><meta charset="utf-8"><title>Subscribed</title>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.2rem">
<h1>You're on the list.</h1><p>We'll email <strong>${esc(row.email)}</strong> the next time
Claude Code usage limits get reset.</p><p><a href="/">Back to the tracker</a></p>`,
        { "content-type": "text/html; charset=utf-8" });
    }

    if (path === "/api/email/unsubscribe") {
      const token = url.searchParams.get("token") ?? "";
      db.prepare(`DELETE FROM email_subs WHERE token = ?`).run(token);
      return send(res, 200,
        `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.2rem">
<h1>Unsubscribed.</h1><p>No more reset emails. <a href="/">Back to the tracker</a></p>`,
        { "content-type": "text/html; charset=utf-8" });
    }

    // "thanks" counter — one shared tally per reset, kept deliberately dumb.
    if (path === "/api/plea") {
      const key = `plea:${url.searchParams.get("reset") ?? "none"}`;
      if (req.method === "POST") {
        if (!rateLimit(`plea:${clientIp(req)}`, 10, 60 * 60_000)) {
          return sendJson(res, 429, { count: Number(getKv(db, key) ?? 0) });
        }
        const next = Number(getKv(db, key) ?? 0) + 1;
        setKv(db, key, next);
        return sendJson(res, 200, { count: next });
      }
      return sendJson(res, 200, { count: Number(getKv(db, key) ?? 0) });
    }

    if (path === "/sponsor") {
      return send(res, 200,
        `<!doctype html><meta charset="utf-8"><title>Sponsor — ${esc(SITE.name)}</title>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.2rem">
<h1>Sponsor the tracker</h1>
<p>Two desktop rail slots and one mobile slot sit beside the reset history. A sticker card with your
logo, name and one line of copy, linking out to you.</p>
<p>Email <a href="mailto:${esc(SITE.contact)}">${esc(SITE.contact)}</a> and we'll send current
traffic and rates.</p><p><a href="/">Back to the tracker</a></p>`,
        { "content-type": "text/html; charset=utf-8" });
    }

    if (req.method === "GET" && await serveStatic(res, path)) return;

    return send(res, 404, "Not found");
  } catch (err) {
    console.error("request failed", path, err);
    if (!res.headersSent) return sendJson(res, 500, { error: "internal error" });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`claudecode-resets listening on :${PORT}`);
  if (process.env.FETCHER !== "off") startFetcher(db);
});
