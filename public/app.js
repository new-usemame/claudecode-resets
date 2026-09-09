/* claudecode-resets.com — client behaviour.
   The page is fully server-rendered; everything here is progressive enhancement. */

const boot = window.__CR__ ?? {};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- time ---------- */

function relative(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function paintTimes() {
  for (const el of $$('[data-role="relative-time"]')) {
    const dt = el.dataset.datetime;
    if (dt) el.textContent = relative(dt);
  }
  // Absolute stamps are rendered in UTC on the server; show the reader's own zone.
  for (const el of $$('[data-role="absolute-time"]')) {
    const dt = el.dataset.datetime;
    if (!dt) continue;
    const d = new Date(dt);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const date = d.toLocaleDateString(undefined, {
      month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    el.textContent = `${date}, ${time}`;
    el.title = `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
}
paintTimes();
setInterval(paintTimes, 60000);

/* ---------- calendar tooltip ---------- */

(() => {
  const grid = $(".cg-grid");
  if (!grid) return;
  const tip = document.createElement("div");
  tip.className = "cg-tooltip";
  tip.hidden = true;
  grid.parentElement.style.position ||= "relative";
  grid.parentElement.appendChild(tip);

  const pretty = (day) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });

  function show(cell) {
    const { date, count, snippet, resetType } = cell.dataset;
    const n = Number(count || 0);
    const head = n
      ? `${n} ${resetType ?? ""} reset${n === 1 ? "" : "s"} · ${pretty(date)}`
      : `No reset · ${pretty(date)}`;
    tip.innerHTML = snippet
      ? `${head}<div class="cg-tooltip-snippet">${snippet.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}…</div>`
      : head;
    tip.hidden = false;
    const box = cell.getBoundingClientRect();
    const host = grid.parentElement.getBoundingClientRect();
    tip.style.left = `${box.left - host.left + box.width / 2 + grid.parentElement.scrollLeft}px`;
    tip.style.top = `${box.top - host.top}px`;
  }
  const hide = () => { tip.hidden = true; };

  for (const cell of $$(".cg-cell[data-date]", grid)) {
    cell.addEventListener("mouseenter", () => show(cell));
    cell.addEventListener("focus", () => show(cell));
    cell.addEventListener("mouseleave", hide);
    cell.addEventListener("blur", hide);
  }
  grid.addEventListener("scroll", hide, { passive: true });

  // The interesting end of a 26-week strip is the recent end. On a narrow screen the
  // grid overflows, so land the reader on today rather than on six months ago.
  const scroller = grid.closest(".cg-scroll") ?? grid.parentElement;
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;
})();

/* ---------- term tooltip (tap target on touch) ---------- */

for (const hint of $$(".term-hint")) {
  hint.addEventListener("click", (e) => {
    e.preventDefault();
    hint.classList.toggle("is-open");
  });
}
document.addEventListener("click", (e) => {
  for (const h of $$(".term-hint.is-open")) if (!h.contains(e.target)) h.classList.remove("is-open");
});

/* ---------- browser push ---------- */

const urlBase64ToUint8Array = (b64) => {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

(async () => {
  const control = $('[data-role="push-control"]');
  const toggle = $('[data-role="push-toggle"]');
  const hint = $('[data-role="push-hint"]');
  if (!control || !toggle) return;
  const supported = "serviceWorker" in navigator && "PushManager" in window && boot.vapidKey;
  if (!supported) return;               // stays hidden; no dead control on unsupported browsers
  control.hidden = false;

  let reg;
  try { reg = await navigator.serviceWorker.register("/sw.js"); }
  catch { return; }

  const setState = (on, message = "") => {
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
    $('[data-role="push-label"]', toggle).textContent = on ? "browser ✓" : "browser";
    hint.textContent = message;
  };

  const existing = await reg.pushManager.getSubscription();
  setState(!!existing);

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      const current = await reg.pushManager.getSubscription();
      if (current) {
        await fetch("/api/push/unsubscribe", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: current.endpoint }),
        });
        await current.unsubscribe();
        setState(false, "Browser alerts off.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState(false, "Notifications are blocked for this site."); return; }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(boot.vapidKey),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error("subscribe failed");
      setState(true, "You'll get a ping on the next reset.");
    } catch (err) {
      setState(false, "Couldn't turn that on. Try again?");
    } finally {
      toggle.disabled = false;
    }
  });
})();

/* ---------- email ---------- */

(() => {
  const toggle = $('[data-role="email-toggle"]');
  const form = $('[data-role="email-form"]');
  const input = $('[data-role="email-input"]');
  const hint = $('[data-role="email-hint"]');
  if (!toggle || !form) return;

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    form.hidden = open;
    if (!open) input.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = $('[data-role="email-submit"]', form);
    submit.disabled = input.disabled = true;
    hint.hidden = false;
    hint.removeAttribute("data-state");
    hint.textContent = "Sending…";
    try {
      const res = await fetch("/api/email/subscribe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: input.value.trim() }),
      });
      const body = await res.json();
      hint.textContent = body.message ?? (res.ok ? "Check your inbox." : "That didn't work.");
      if (res.ok) {
        hint.setAttribute("data-state", "success");
        toggle.dataset.state = "sent";
        form.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
    } catch {
      hint.textContent = "Network hiccup. Try again in a moment.";
    } finally {
      submit.disabled = input.disabled = false;
    }
  });
})();

/* ---------- thanks button ---------- */

(() => {
  const plea = $('[data-role="reset-plea"]');
  if (!plea) return;
  const button = $('[data-role="reset-plea-button"]', plea);
  const count = $('[data-role="reset-plea-count"]', plea);
  const bursts = $('[data-role="reset-plea-bursts"]', plea);
  const resetAt = plea.dataset.resetAt || "none";
  const key = `claudecode-resets:thanks:${resetAt}`;

  const paint = (n) => { count.textContent = n > 0 ? String(n) : ""; count.setAttribute("aria-label", `${n} thanks`); };

  fetch(`/api/plea?reset=${encodeURIComponent(resetAt)}`)
    .then((r) => r.json()).then((d) => paint(d.count)).catch(() => {});

  button.addEventListener("click", async () => {
    button.classList.add("is-pleading");
    setTimeout(() => button.classList.remove("is-pleading"), 600);

    const burst = document.createElement("span");
    burst.className = "reset-plea-burst";
    burst.textContent = "🙏";
    bursts.appendChild(burst);
    setTimeout(() => burst.remove(), 1200);

    // One vote per browser per reset; the button still animates every tap.
    let already = false;
    try { already = localStorage.getItem(key) === "1"; } catch {}
    if (already) return;
    try { localStorage.setItem(key, "1"); } catch {}

    try {
      const r = await fetch(`/api/plea?reset=${encodeURIComponent(resetAt)}`, { method: "POST" });
      paint((await r.json()).count);
    } catch {}
  });
})();

/* ---------- sponsor dialog ---------- */

(() => {
  const dialog = $('[data-role="sponsor-dialog"]');
  if (!dialog) return;
  for (const card of $$('[data-role="sponsor-open"]')) {
    card.addEventListener("click", (e) => { e.preventDefault(); dialog.showModal(); });
  }
  $('[data-role="sponsor-dialog-close"]', dialog)?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
})();
