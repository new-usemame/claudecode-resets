import { esc, absoluteUTC, relativeTime, jsonScript } from "./util.js";

export const SITE = {
  name: "Claude Code Resets",
  origin: process.env.SITE_ORIGIN || "https://claudecode-resets.com",
  account: "ClaudeDevs",
  accountUrl: "https://x.com/ClaudeDevs",
  contact: "hello@claudecode-resets.com",
};

const THEME_SCRIPT = `(() => {
  const KEY = "claudecode-resets-theme", LIGHT = "light", DARK = "dark";
  const COLORS = { light: "#fff4dd", dark: "#17130f" };
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = null;
  const read = () => { try { const v = localStorage.getItem(KEY); return v === LIGHT || v === DARK ? v : null; } catch { return null; } };
  const write = (t) => { preference = t; try { localStorage.setItem(KEY, t); } catch {} };
  function sync(scope = document) {
    const theme = root.dataset.theme === DARK ? DARK : LIGHT;
    const next = theme === DARK ? LIGHT : DARK;
    scope.querySelectorAll('[data-role="theme-toggle"]').forEach((b) => {
      b.setAttribute("aria-pressed", theme === DARK ? "true" : "false");
      b.setAttribute("aria-label", "Switch to " + next + " mode");
      b.setAttribute("title", "Switch to " + next + " mode");
    });
  }
  function apply(theme) {
    const t = theme === DARK ? DARK : LIGHT;
    root.dataset.theme = t; root.style.colorScheme = t;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", COLORS[t]));
    sync();
  }
  preference = read();
  apply(preference ?? (system.matches ? DARK : LIGHT));
  root.classList.add("theme-controls-enabled");
  system.addEventListener?.("change", () => { if (!preference) apply(system.matches ? DARK : LIGHT); });
  document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest('[data-role="theme-toggle"]')) {
      const next = root.dataset.theme === DARK ? LIGHT : DARK; write(next); apply(next);
    }
  });
  document.addEventListener("DOMContentLoaded", () => sync());
})();`;

const RESET_TYPE_COPY = {
  full: {
    label: "Full reset",
    tip: "Everyone on a paid plan got their counters flushed — 5-hour and, when Anthropic says so, weekly limits too.",
  },
  partial: {
    label: "Partial reset",
    tip: "A reset that only covered some people — one plan tier, or just the users hit by an incident. If you were outside that group your limits did not move.",
  },
};

const AVATAR = "/mark.svg";

function subscriptionActions() {
  const telegram = process.env.TELEGRAM_URL;
  return `  <div class="subscription-actions" role="group" aria-label="Reset notifications">
    <div class="push-control" data-role="push-control" hidden>
      <button class="subscription-action push-toggle" type="button" data-role="push-toggle" aria-pressed="false" aria-describedby="push-hint" title="Get browser notifications when Claude Code resets">
        <svg class="push-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        <span data-role="push-label">browser</span>
      </button>
      <span class="push-hint" id="push-hint" data-role="push-hint" aria-live="polite"></span>
    </div>
${telegram ? `    <a class="subscription-action telegram-link" data-role="telegram-link" href="${esc(telegram)}" target="_blank" rel="noopener noreferrer" title="Same pings, in Telegram">
      <svg class="telegram-link-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22 2 9.6 14.4M22 2l-7.9 20-4.5-7.6L2 10l20-8Z" />
      </svg>
      <span>telegram</span>
    </a>
` : ""}    <button class="subscription-action email-toggle" type="button" data-role="email-toggle" aria-expanded="false" aria-controls="email-subscribe-form" aria-describedby="email-hint" title="Get an email when a Claude Code reset is confirmed">
      <svg class="email-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 5h18v14H3zM3 6l9 7 9-7" />
      </svg>
      <span data-role="email-label">email</span>
    </button>
    <form class="email-subscribe-form" id="email-subscribe-form" data-role="email-form" hidden>
      <label class="visually-hidden" for="reset-email">Email address</label>
      <input class="email-input" id="reset-email" data-role="email-input" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="you@example.com" aria-describedby="email-hint" required />
      <button class="subscription-action email-submit" data-role="email-submit" type="submit">send link</button>
    </form>
    <p class="email-hint" id="email-hint" data-role="email-hint" aria-live="polite" hidden></p>
  </div>`;
}

function heroCard(latest, now) {
  if (!latest) {
    return `  <div class="hero-card">
    <span class="hero-label">Latest Claude Code reset</span>
    <span class="hero-figure hero-figure--muted">no resets tracked yet</span>
  </div>`;
  }
  const copy = RESET_TYPE_COPY[latest.reset_type] ?? RESET_TYPE_COPY.full;
  const tipId = `${latest.reset_type}-reset-tip`;
  return `  <div class="hero-card">
    <span class="hero-label">Latest Claude Code reset</span>
    <span class="hero-figure" data-role="relative-time" data-datetime="${esc(latest.announced_at)}">${esc(relativeTime(latest.announced_at, now))}</span>
    <div class="hero-footer">
      <p class="hero-sub${latest.reset_type === "partial" ? " hero-sub--partial" : ""}">
        <span class="hero-reset-type-meta"><span class="term-hint" tabindex="0" aria-describedby="${tipId}"><strong>${esc(copy.label)}</strong><span class="term-tooltip" id="${tipId}" role="tooltip">${esc(copy.tip)}</span></span><span aria-hidden="true">·</span></span>
        <span data-role="absolute-time" data-datetime="${esc(latest.announced_at)}">${esc(absoluteUTC(latest.announced_at))}</span>
      </p>
      <section class="reset-plea" data-role="reset-plea" data-mode="thanks" data-reset-at="${esc(latest.announced_at)}" aria-label="Reset reactions">
        <div class="reset-plea-action">
          <button class="reset-plea-button" type="button" data-role="reset-plea-button" aria-label="Say thanks for the reset" title="Say thanks for the reset">
            <span class="reset-plea-button-emoji" aria-hidden="true">🙏</span>
            <span class="reset-plea-button-label" data-role="reset-plea-label">thanks</span>
            <span class="reset-plea-count" data-role="reset-plea-count" role="status" aria-live="polite" aria-atomic="true"></span>
          </button>
          <span class="reset-plea-bursts" data-role="reset-plea-bursts" aria-hidden="true"></span>
        </div>
      </section>
    </div>
  </div>`;
}

function statRow(stats) {
  const fmt = (n, suffix = "") => (n == null ? "—" : `${n}${suffix}`);
  return `  <dl class="stat-row">
    <div class="stat-tile stat-tile--sun">
      <dt><span class="stat-label-full">Resets</span><span class="stat-label-short">Resets</span></dt>
      <dd class="mono">${stats.total}</dd>
    </div>
    <div class="stat-tile stat-tile--rose">
      <dt><span class="stat-label-full">Avg. miracle interval</span><span class="stat-label-short">Avg. wait</span></dt>
      <dd class="mono">${fmt(stats.avg_interval_days, "d")}</dd>
    </div>
    <div class="stat-tile stat-tile--sky">
      <dt><span class="stat-label-full">Longest wait</span><span class="stat-label-short">Longest wait</span></dt>
      <dd class="mono">${fmt(stats.longest_wait_days, "d")}</dd>
    </div>
  </dl>`;
}

const sponsorCard = (compact) => `<a class="sponsor-card${compact ? " sponsor-card--compact" : ""} sponsor-card--advertise" href="/sponsor" data-role="sponsor-open">
  <span class="sponsor-label">Sponsor</span>
  <span class="sponsor-advertise-mark" aria-hidden="true">+</span>
  <span class="sponsor-copy"><strong>Your product here</strong><span>One line that makes developers click.</span></span>
</a>`;

function calendarSection(cal) {
  const weekdays = ["", "Mon", "", "Wed", "", "Fri", ""]
    .map((label, i) => `<span class="cg-weekday" style="grid-row:${i + 2}">${label}</span>`).join("");
  const months = cal.months
    .map((m) => `<span class="cg-month" style="grid-column:${m.column};grid-row:1">${m.label}</span>`).join("");
  const cells = cal.cells.map((c) => {
    const style = `grid-column:${c.column};grid-row:${c.row}`;
    const label = c.count
      ? `${c.count} ${c.type} reset${c.count === 1 ? "" : "s"} on ${c.date} (UTC)`
      : `No reset on ${c.date} (UTC)`;
    const attrs = `data-level="${c.count ? 1 : 0}"${c.type ? ` data-reset-type="${c.type}"` : ""} data-date="${c.date}" data-count="${c.count}" data-snippet="${esc(c.snippet)}" style="${style}" aria-label="${esc(label)}"`;
    return c.href
      ? `<a class="cg-cell" ${attrs} href="${esc(c.href)}" target="_blank" rel="noopener noreferrer"></a>`
      : `<button type="button" class="cg-cell" ${attrs}></button>`;
  }).join("");

  return `<section class="graph-section" aria-labelledby="graph-heading">
  <div class="section-head">
    <h2 id="graph-heading">Claude Code reset history</h2>
    <p class="section-sub graph-legend">
      <span>Last ${cal.weeks} weeks</span>
      <span class="legend-item"><span class="legend-chip legend-chip--regular"></span> full</span>
      <span class="legend-item"><span class="legend-chip legend-chip--partial"></span> partial</span>
      <span class="legend-item"><span class="legend-chip"></span> no reset</span>
    </p>
  </div>
  <div class="graph-card">
    <div class="cg-container">
      <div class="cg-weekdays" style="grid-template-rows:20px repeat(7,var(--cell-size))">${weekdays}</div>
      <div class="cg-scroll">
        <div class="cg-grid" style="grid-template-columns:repeat(${cal.columns},var(--cell-size));grid-template-rows:20px repeat(7,var(--cell-size))">
          ${months}${cells}
        </div>
      </div>
    </div>
  </div>
</section>`;
}

function logItem(e, now) {
  // A full reset is the norm and needs no label — only the exceptions get a chip,
  // which keeps an ordinary reset row identical to the reference's.
  const kindChip = e.kind === "policy"
    ? `<span class="log-item-kind log-item-kind--policy">limit change</span>`
    : e.reset_type === "partial"
      ? `<span class="log-item-kind log-item-kind--partial">partial</span>`
      : "";
  // An entry the fetcher classified but no human has reviewed yet is still sourced
  // from the post itself — but say so, rather than let it pass as checked.
  const provisional = e.verification === "provisional"
    ? `<span class="log-item-kind log-item-kind--provisional" title="Detected automatically and sourced from the original post, but not yet reviewed by a human">auto</span>`
    : "";
  return `    <li class="log-item" data-kind="${e.kind}">
      <img class="log-avatar" src="${AVATAR}" alt="" aria-hidden="true" loading="lazy" width="44" height="44" />
      <div class="log-bubble">
        <div class="log-item-meta">
${kindChip ? `\n          ${kindChip}` : ""}${provisional ? `\n          ${provisional}` : ""}
          <span class="log-item-time" data-role="relative-time" data-datetime="${esc(e.announced_at)}">${esc(relativeTime(e.announced_at, now))}</span>
          <span class="log-item-abs" data-role="absolute-time" data-datetime="${esc(e.announced_at)}">${esc(absoluteUTC(e.announced_at))}</span>
        </div>
        <p class="log-item-text">${esc(e.text)}</p>
        <a class="log-item-link" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">View on X &rarr;</a>
      </div>
    </li>`;
}

function logSection(events, now) {
  if (!events.length) {
    return `<section class="log-section" aria-labelledby="log-heading">
  <div class="section-head"><h2 id="log-heading">Claude Code reset announcements</h2>
  <p class="section-sub">Every announcement, preserved for history</p></div>
  <p class="log-empty">Nothing tracked yet.</p>
</section>`;
  }
  const head = events.slice(0, 3), rest = events.slice(3);
  return `<section class="log-section" aria-labelledby="log-heading">
  <div class="section-head">
    <h2 id="log-heading">Claude Code reset announcements</h2>
    <p class="section-sub">Every announcement, preserved for history</p>
  </div>
  <ol class="log-list">
${head.map((e) => logItem(e, now)).join("\n")}</ol>
${rest.length ? `  <details class="log-more">
    <summary class="log-more-toggle">
      <span class="log-more-label-closed">Show all ${events.length} announcements</span>
      <span class="log-more-label-open">Show fewer</span>
      <span class="log-more-arrow" aria-hidden="true">&darr;</span>
    </summary>
    <ol class="log-list log-list--more" start="4">
${rest.map((e) => logItem(e, now)).join("\n")}</ol>
  </details>
` : ""}</section>`;
}

export function renderPage({ events, resets, stats, calendar, vapidKey, now = Date.now() }) {
  const latest = resets[0] ?? null;
  const desc = "Track the latest Claude Code usage-limit reset, browse the full reset history, and get notified when Anthropic announces a new one.";
  const title = "Claude Code Limit Reset Tracker & History | Claude Code Resets";
  const bootstrap = { vapidKey: vapidKey ?? null, latestResetAt: latest?.announced_at ?? null };

  return `<!doctype html>
<html lang="en" data-theme-scope="site">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#fff4dd" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${esc(SITE.name)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${esc(SITE.origin)}/" />
  <meta property="og:image" content="${esc(SITE.origin)}/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(SITE.origin)}/og-image.png" />
  <link rel="canonical" href="${esc(SITE.origin)}/" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="icon" href="${AVATAR}" type="image/svg+xml" />
  <link rel="preload" as="font" type="font/woff2" href="/fonts/Baloo2-Bold.woff2" crossorigin />
  <link rel="preload" as="font" type="font/woff2" href="/fonts/Baloo2-ExtraBold.woff2" crossorigin />
  <script type="application/ld+json">${jsonScript({
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "WebSite", "@id": `${SITE.origin}/#website`, url: `${SITE.origin}/`,
      name: SITE.name, description: desc, inLanguage: "en", sameAs: [SITE.accountUrl],
    }],
  })}</script>
  <script>${THEME_SCRIPT}</script>
  <link rel="stylesheet" href="/styles.css" />
  <script type="module" src="/app.js"></script>
  <script>window.__CR__ = ${jsonScript(bootstrap)};</script>
</head>
<body>
  <div id="app" data-ssr="1">
<div class="sponsor-layout">
<div class="page">
  <header class="masthead">
    <div class="masthead-brand">
      <img class="masthead-avatar" src="${AVATAR}" alt="" aria-hidden="true" width="44" height="44" />
      <div class="masthead-copy">
        <div class="masthead-title-row">
          <h1 class="masthead-title">Claude Code Resets</h1>
        </div>
      </div>
    </div>
    <div class="masthead-side">
      <a class="x-link" data-role="x-link" href="${esc(SITE.accountUrl)}" target="_blank" rel="noopener noreferrer" title="Follow @${esc(SITE.account)} — the account we watch" aria-label="Follow @${esc(SITE.account)} on X">
        <svg class="x-link-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.23 10.16 22.1 1h-1.87l-6.84 7.96L8.04 1H1.5l8.26 12.03L1.5 23h1.87l7.22-8.4L15.96 23H22.5l-8.27-12.84Zm-2.56 2.97-.83-1.19L4.04 2.43h2.86l5.34 7.64.84 1.19 6.94 9.93h-2.86l-5.49-7.06Z" />
        </svg>
      </a>
      <button class="theme-toggle" type="button" data-role="theme-toggle" aria-label="Toggle color theme" title="Toggle color theme">
        <span class="theme-toggle-icons" aria-hidden="true">
          <svg class="theme-toggle-icon theme-toggle-icon--moon" viewBox="0 0 24 24">
            <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />
          </svg>
          <svg class="theme-toggle-icon theme-toggle-icon--sun" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        </span>
      </button>
    </div>
  </header>

  <main>
<section class="hero" aria-label="Current status">
  <p class="hero-explainer">
    We watch <a href="${esc(SITE.accountUrl)}" target="_blank" rel="noopener noreferrer">@${esc(SITE.account)}</a>
    for Claude Code reset announcements, so you don't have to.
  </p>

${subscriptionActions()}

${heroCard(latest, now)}

${statRow(stats)}

  <div class="sponsor-mobile" data-role="sponsor-mobile" aria-label="Sponsorship">${sponsorCard(true)}</div>
</section>

${calendarSection(calendar)}

${logSection(events, now)}
  </main>

  <footer class="site-footer">
    <p>Data from <a href="${esc(SITE.accountUrl)}" target="_blank" rel="noopener noreferrer">@${esc(SITE.account)}</a> and Claude Code team members on X, classified by a robot that takes this very seriously.</p>
    <p>Independent project. Not affiliated with, endorsed by, or operated by Anthropic.</p>
    <p>Want the data? There's a free public <a href="/api/docs">API</a> and an <a href="/rss.xml">RSS feed</a>.</p>
    <p>Built by <a href="https://github.com/new-usemame" target="_blank" rel="noopener noreferrer">new-usemame</a>.</p>
  </footer>
</div>
<aside class="sponsor-rail sponsor-rail--left" data-role="sponsor-left" aria-label="Sponsorship">${sponsorCard(false)}</aside>
<aside class="sponsor-rail sponsor-rail--right" data-role="sponsor-right" aria-label="Sponsorship">${sponsorCard(false)}</aside>
<dialog class="sponsor-dialog" data-role="sponsor-dialog" aria-labelledby="sponsor-dialog-title">
  <button class="sponsor-dialog-close" type="button" data-role="sponsor-dialog-close" aria-label="Close"><span aria-hidden="true">&times;</span></button>
  <section data-role="sponsor-offer-view">
    <span class="sponsor-dialog-kicker">Sponsorship</span>
    <h2 id="sponsor-dialog-title">Reach developers using Claude Code</h2>
    <p class="sponsor-dialog-sub">A sticker card beside the tracker with your logo, name, and tagline, linking out to you &mdash; for a full month.</p>
    <div class="sponsor-offer-preview">
      <div class="sponsor-card sponsor-card--compact sponsor-offer-preview-card" aria-hidden="true">
        <span class="sponsor-label">Sponsor</span>
        <span class="sponsor-logo">?</span>
        <span class="sponsor-copy"><strong>Your product</strong><span>One line that makes developers click.</span></span>
      </div>
      <span class="sponsor-offer-preview-note">Desktop rails &middot; mobile in-flow</span>
    </div>
    <p class="sponsor-dialog-steps">Two rail slots and one mobile slot. Tell us what you'd like to run and we'll send rates and current traffic.</p>
    <p class="sponsor-dialog-contact">Email <a href="mailto:${esc(SITE.contact)}">${esc(SITE.contact)}</a></p>
  </section>
</dialog>
</div></div>
</body>
</html>`;
}
