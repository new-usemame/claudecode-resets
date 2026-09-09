export const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Serialize for embedding in a <script> block. */
export const jsonScript = (v) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export const DAY_MS = 86_400_000;

/** UTC calendar day, "YYYY-MM-DD". */
export const utcDay = (d) => new Date(d).toISOString().slice(0, 10);

export const parseDay = (s) => new Date(`${s}T00:00:00.000Z`);

/** "Sep 9, 2026, 6:23 PM UTC" — matches the reference's absolute stamp. */
export function absoluteUTC(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}

/** "2 minutes ago" / "3 days ago" — server-side twin of the client formatter. */
export function relativeTime(iso, now = Date.now()) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export const round1 = (n) => Math.round(n * 10) / 10;
