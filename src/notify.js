import webpush from "web-push";
import { randomUUID } from "node:crypto";
import { SITE } from "./render.js";
import { wasNotified, markNotified } from "./store.js";

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? `mailto:${SITE.contact}`;
const RESEND_KEY = process.env.RESEND_API_KEY ?? "";
const MAIL_FROM = process.env.MAIL_FROM ?? `Claude Code Resets <resets@claudecode-resets.com>`;

let pushReady = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  pushReady = true;
} else {
  console.warn("push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set");
}

export const vapidPublicKey = () => (pushReady ? VAPID_PUBLIC : null);

export const addPushSub = (db, sub) =>
  db.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth) VALUES (?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);

export const removePushSub = (db, endpoint) =>
  db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).run(endpoint);

async function sendMail(to, subject, html, text) {
  if (!RESEND_KEY) { console.warn("email disabled: RESEND_API_KEY not set"); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text }),
  });
  if (!r.ok) { console.error("resend failed", r.status, (await r.text()).slice(0, 300)); return false; }
  return true;
}

/** Double opt-in: we only ever mail an address that clicked its own confirm link. */
export async function requestEmailConfirmation(db, email) {
  const existing = db.prepare(`SELECT token, confirmed_at FROM email_subs WHERE email = ?`).get(email);
  if (existing?.confirmed_at) return { state: "confirmed", message: "You're already on the list." };

  const token = existing?.token ?? randomUUID();
  db.prepare(`INSERT INTO email_subs (email, token) VALUES (?, ?)
              ON CONFLICT(email) DO UPDATE SET token = excluded.token`).run(email, token);

  const link = `${SITE.origin}/api/email/confirm?token=${token}`;
  const ok = await sendMail(email, "Confirm your Claude Code reset alerts",
    `<p>Tap to confirm you want an email whenever Claude Code usage limits get reset:</p>
     <p><a href="${link}">${link}</a></p>
     <p style="color:#666;font-size:13px">If you didn't ask for this, ignore it — nothing is sent until you confirm.</p>`,
    `Confirm your Claude Code reset alerts: ${link}`);

  return ok
    ? { state: "sent", message: "Check your inbox for the confirmation link." }
    : { state: "error", message: "Couldn't send that right now. Try again in a minute." };
}

/** Fan a confirmed reset out to every channel, exactly once per event per channel. */
export async function announce(db, event) {
  if (event.kind !== "reset") return { push: 0, email: 0 };
  const results = { push: 0, email: 0 };

  if (pushReady && !wasNotified(db, event.id, "push")) {
    const subs = db.prepare(`SELECT * FROM push_subs`).all();
    const payload = JSON.stringify({
      title: event.reset_type === "partial" ? "Claude Code partial reset" : "Claude Code reset",
      body: event.text.slice(0, 180),
      url: SITE.origin,
    });
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        results.push += 1;
      } catch (err) {
        // 404/410 means the browser dropped the subscription — stop mailing a dead endpoint.
        if (err?.statusCode === 404 || err?.statusCode === 410) removePushSub(db, s.endpoint);
        else console.error("push failed", err?.statusCode, err?.message);
      }
    }
    markNotified(db, event.id, "push");
  }

  if (RESEND_KEY && !wasNotified(db, event.id, "email")) {
    const subs = db.prepare(`SELECT email, token FROM email_subs WHERE confirmed_at IS NOT NULL`).all();
    const label = event.reset_type === "partial" ? "A partial Claude Code reset" : "Claude Code limits were reset";
    for (const s of subs) {
      const unsub = `${SITE.origin}/api/email/unsubscribe?token=${s.token}`;
      const ok = await sendMail(s.email, label,
        `<p><strong>${label}.</strong></p><blockquote>${event.text.replace(/\n/g, "<br>")}</blockquote>
         <p><a href="${event.url}">View the announcement on X</a> &middot; <a href="${SITE.origin}">Open the tracker</a></p>
         <p style="color:#888;font-size:12px"><a href="${unsub}">Unsubscribe</a></p>`,
        `${label}\n\n${event.text}\n\n${event.url}\n\nUnsubscribe: ${unsub}`);
      if (ok) results.email += 1;
    }
    markNotified(db, event.id, "email");
  }

  return results;
}
