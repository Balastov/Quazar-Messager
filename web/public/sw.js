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

  if (data.type === "star_door") {
    // Двери комнат Созвездия: «зовёт вас», «стучится», ответ на стук.
    const door = data.door || "invite";
    const actions =
      door === "invite"
        ? [{ action: "join", title: data.action_title || "Войти" }]
        : door === "knock"
          ? [
              { action: "admit", title: "Впустить" },
              { action: "deny", title: "Отказать" },
            ]
          : [];
    const options = {
      body: data.body || "",
      tag: `quazar-door-${data.knock_id || data.channel_id || "x"}`,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-48.png",
      requireInteraction: door === "invite" || door === "knock",
      renotify: true,
      data: {
        kind: "door",
        starId: data.star_id || null,
        channelId: data.channel_id || null,
        door,
        knockId: data.knock_id || null,
        lobbyChannelId: data.lobby_channel_id || null,
      },
      actions,
    };
    event.waitUntil(self.registration.showNotification(data.title || "Quazar", options));
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

  if (data.kind === "door" && data.starId && data.channelId) {
    const link = {
      starId: data.starId,
      channelId: data.channelId,
      door: data.door,
      knockId: data.knockId || null,
      lobbyChannelId: data.lobbyChannelId || null,
      action: action || null,
    };
    const params = new URLSearchParams({ star: link.starId, planet: link.channelId, door: link.door });
    if (link.knockId) params.set("knock", link.knockId);
    if (link.lobbyChannelId) params.set("lobby", link.lobbyChannelId);
    if (link.action) params.set("do", link.action);
    event.waitUntil(openOrFocus(`/?${params.toString()}`, { type: "quazar-star-door", link }));
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
