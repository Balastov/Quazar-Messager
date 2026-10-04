/* Quazar service worker — уведомления для PWA / домашнего экрана */
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chatId = event.notification.data && event.notification.data.chatId;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.registration.scope) && "focus" in client) {
          client.postMessage({ type: "quazar-open-chat", chatId: chatId || null });
          return client.focus();
        }
      }
      const url = chatId ? `/?chat=${encodeURIComponent(chatId)}` : "/";
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
      return undefined;
    })
  );
});
