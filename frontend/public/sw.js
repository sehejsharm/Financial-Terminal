/* Service worker: receives Web Push alerts and shows OS notifications.
   Registered from the Alerts page when the user enables push delivery. */
self.addEventListener("push", (event) => {
  let data = { title: "Motherboard Terminal", body: "Alert triggered", url: "/alerts" };
  try {
    data = { ...data, ...event.data.json() };
  } catch (e) { /* non-JSON payload — use defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/alerts";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(url); return c.focus(); }
      }
      return clients.openWindow(url);
    }),
  );
});
