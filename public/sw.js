self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text() ?? "" }; }
  // Tell any open tab what arrived. The notification is the product; this makes
  // delivery observable, which is the only way to actually verify the push path.
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      client.postMessage({ type: "push-received", data });
    }
  })());
  event.waitUntil(self.registration.showNotification(data.title ?? "Claude Code Resets", {
    body: data.body ?? "Usage limits were reset.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url ?? "/" },
    tag: "claudecode-reset",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if (w.url.startsWith(self.location.origin) && "focus" in w) return w.focus();
    return clients.openWindow(url);
  }));
});
