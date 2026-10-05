/* Quazar service worker — notifications + Web Push for PWA */

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function openOrFocus(url, message) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.includes(self.registration.scope) && "focus" in client) {
        if (message) client.postMessage(message);
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(url);
    }
    return undefined;
  });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  if (data.type === "incoming_call") {
    const name = data.caller_name || "Собеседник";
    const isVideo = !!(data.media && data.media.video);
    const title = isVideo ? "Входящий видеозвонок" : "Входящий звонок";
    const options = {
      body: name,
      tag: `quazar-call-${data.call_id || "unknown"}`,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-48.png",
      requireInteraction: true,
      renotify: true,
      data: {
        kind: "call",
        callId: data.call_id || null,
        chatId: data.chat_id || null,
        callerId: data.caller_id || null,
        callerName: name,
        media: data.media || { audio: true, video: false },
      },
      actions: [
        { action: "accept", title: "Принять" },
        { action: "reject", title: "Отклонить" },
      ],
    };
    event.waitUntil(self.registration.showNotification(title, options));
    return;
  }

  const title = data.title || "Quazar";
  const options = {
    body: data.body || "Новое уведомление",
    tag: data.tag || "quazar-push",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-48.png",
    data: { kind: "message", chatId: data.chatId || data.chat_id || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;

  if (data.kind === "call") {
    const callId = data.callId;
    const chatId = data.chatId;
    let type = "quazar-open-call";
    if (action === "accept") type = "quazar-accept-call";
    if (action === "reject") type = "quazar-reject-call";

    const params = new URLSearchParams();
    if (chatId) params.set("chat", chatId);
    if (callId) params.set("call", callId);
    if (action === "accept") params.set("callAction", "accept");
    if (action === "reject") params.set("callAction", "reject");
    const url = `/?${params.toString()}`;

    event.waitUntil(
      openOrFocus(url, {
        type,
        callId,
        chatId,
        callerId: data.callerId || null,
        callerName: data.callerName || null,
        media: data.media || null,
      })
    );
    return;
  }

  const chatId = data.chatId;
  event.waitUntil(
    openOrFocus(chatId ? `/?chat=${encodeURIComponent(chatId)}` : "/", {
      type: "quazar-open-chat",
      chatId: chatId || null,
    })
  );
});
