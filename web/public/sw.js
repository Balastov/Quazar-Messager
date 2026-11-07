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

async function showMessageNotification(data, title, options) {
  // Push должен всегда завершаться видимым уведомлением (в том числе в Safari).
  // Тег сообщения совпадает с WS-уведомлением; повторная доставка не тревожит снова.
  await self.registration.showNotification(title, options);
  try {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    if (data.message_id) windows.forEach(client => client.postMessage({type: "quazar-push-shown", messageId: data.message_id, userId: data.recipient_user_id}));
  } catch { /* Notification was already displayed; a closed page needs no acknowledgement. */ }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  if (data.type === "connection_test") {
    event.waitUntil((async () => {
      await self.registration.showNotification(data.title || "Quazar — проверка связи", {
        body: data.body || "Тестовое уведомление с сервера", tag: `quazar-test-${data.test_id}`,
        icon: "/icons/icon-192.png?v=neon-q-2", badge: "/icons/icon-48.png?v=neon-q-2",
        silent: false, data: { kind: "diagnostic" },
      });
      if (!/^[0-9a-f-]{36}$/i.test(data.test_id || "") || !/^[A-Za-z0-9_-]{43}$/.test(data.receipt_secret || "")) return;
      try {
        await fetch(`/api/push/diagnostics/${encodeURIComponent(data.test_id)}/receipt`, {
          method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: data.receipt_secret }),
        });
      } catch { /* The visible notification still works while the server is unreachable. */ }
    })());
    return;
  }

  if (data.type === "incoming_call") {
    const name = data.caller_name || "Собеседник";
    const isVideo = !!(data.media && data.media.video);
    const title = isVideo ? "Входящий видеозвонок" : "Входящий звонок";
    const options = {
      body: name,
      tag: `quazar-call-${data.call_id || "unknown"}`,
      icon: "/icons/icon-192.png?v=neon-q-2",
      badge: "/icons/icon-48.png?v=neon-q-2",
      requireInteraction: true,
      silent: !!data.silent,
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
      icon: "/icons/icon-192.png?v=neon-q-2",
      badge: "/icons/icon-48.png?v=neon-q-2",
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

  if (data.type === "star_message") {
    // Сообщение Спутника: упоминание, ответ мне или всё подряд — по уровню уведомлений.
    const options = {
      body: data.body || "",
      tag: data.tag || `quazar-star-${data.channel_id || "x"}`,
      icon: "/icons/icon-192.png?v=neon-q-2",
      badge: "/icons/icon-48.png?v=neon-q-2",
      renotify: false,
      silent: !!data.silent,
      data: { kind: "star", starId: data.star_id || null, channelId: data.channel_id || null, messageId: data.message_id || null, threadId: data.thread_id || null },
    };
    event.waitUntil(showMessageNotification(data, data.title || "Quazar", options));
    return;
  }

  if (data.type === "chat_message") {
    event.waitUntil(showMessageNotification(data, data.title || "Quazar", {
      body: data.body || "Новое сообщение", tag: data.tag || `quazar-message-${data.message_id || data.chat_id}`,
      icon: "/icons/icon-192.png?v=neon-q-2", badge: "/icons/icon-48.png?v=neon-q-2",
      renotify: false, silent: !!data.silent, data: {kind: "message", chatId: data.chat_id || null},
    }));
    return;
  }

  const title = data.title || "Quazar";
  const options = {
    body: data.body || "Новое уведомление",
    tag: data.tag || "quazar-push",
    icon: "/icons/icon-192.png?v=neon-q-2",
    badge: "/icons/icon-48.png?v=neon-q-2",
    data: { kind: "message", chatId: data.chatId || data.chat_id || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;

  if (data.kind === "diagnostic") {
    event.waitUntil(openOrFocus("/", null));
    return;
  }

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

  if (data.kind === "star" && data.starId && data.channelId) {
    const params = new URLSearchParams({ star: data.starId, channel: data.channelId });
    if (data.messageId) params.set("message", data.messageId);
    if (data.threadId) params.set("thread", data.threadId);
    event.waitUntil(
      openOrFocus(`/?${params.toString()}`, {
        type: "quazar-open-star",
        starId: data.starId,
        channelId: data.channelId,
        messageId: data.messageId || null,
        threadId: data.threadId || null,
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
