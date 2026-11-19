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

// Браузер долго был офлайн — push-сервис отдаёт накопленное пачкой. Чтобы не звенело на каждое:
// сообщения одного чата (канала) складываются в одно уведомление «Новых сообщений: N»,
// звук — не чаще раза в QUIET_GAP_MS, а пролежавшие в очереди дольше STALE_MS — без звука.
const QUIET_GAP_MS = 5000;
const STALE_MS = 2 * 60 * 1000;
let lastAudibleAt = 0;

function isStale(data, now = Date.now()) {
  const sentAt = Date.parse(data.sent_at || "");
  return Number.isFinite(sentAt) && now - sentAt > STALE_MS;
}

function audible(data) {
  if (data.silent || isStale(data)) return false;
  const now = Date.now();
  if (now - lastAudibleAt < QUIET_GAP_MS) return false;
  lastAudibleAt = now;
  return true;
}

/** Одно уведомление на чат/канал: сколько сообщений в нём уже накопилось (с этим). */
async function groupCount(tag) {
  try {
    const [existing] = await self.registration.getNotifications({ tag });
    return existing ? (existing.data && existing.data.count ? existing.data.count : 1) + 1 : 1;
  } catch {
    return 1;
  }
}

/** Уведомление, которое страница уже показала об этом сообщении (своим тегом), или null. */
async function shownByPage(tag) {
  if (!tag) return null;
  try {
    return (await self.registration.getNotifications({ tag }))[0] || null;
  } catch {
    return null;
  }
}

async function showGroupedMessage(data, title, groupTag, pageTag, body, options) {
  const page = await shownByPage(pageTag);
  if (page) {
    // Второе уведомление не нужно, но push обязан что-то показать (Safari): тихо обновляем то же.
    await showMessageNotification(data, page.title, { ...options, body: page.body, tag: pageTag, renotify: false, silent: true });
    return;
  }
  const count = await groupCount(groupTag);
  const sound = audible(data);
  await showMessageNotification(data, title, {
    ...options,
    body: body(count),
    tag: groupTag,
    // Та же метка: заменяем прежнее уведомление; звенит, только если звук сейчас уместен.
    renotify: sound,
    silent: !sound,
    data: { ...options.data, count },
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

// Открытый Quazar показывает экран — уведомления увидели бы зрители. Спрашиваем сами окна: состояние
// в воркере не храним, он может перезапуститься. Не ответили быстро — считаем, что показа нет.
async function presenting() {
  let windows = [];
  try {
    windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch {
    return false;
  }
  if (!windows.length || typeof MessageChannel === "undefined") return false;
  const answers = windows.map((client) => new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 300);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(!!(event.data && event.data.presenting));
    };
    try {
      client.postMessage({ type: "quazar-presenting?" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  }));
  return (await Promise.all(answers)).some(Boolean);
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

  // Показ экрана: страница сама даёт звук сообщения; входящий звонок не показывается и молчит.
  event.waitUntil((async () => {
    if (await presenting()) return;
    await showPush(data);
  })());
});

async function showPush(data) {
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
    await self.registration.showNotification(title, options);
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
    await self.registration.showNotification(data.title || "Quazar", options);
    return;
  }

  if (data.type === "device_key_request") {
    // Новое устройство просит открыть на нём переписку. Открытое приложение спросит «Это вы входите?»
    // само — уведомление нужно, только когда Quazar закрыт или свёрнут.
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients.some((client) => client.visibilityState === "visible")) return;
    await self.registration.showNotification(data.title || "Вход в Quazar на новом устройстве", {
      body: data.body || "Откройте Quazar, чтобы подтвердить, что это вы.",
      tag: `quazar-keys-${data.request_id || "x"}`,
      icon: "/icons/icon-192.png?v=neon-q-2",
      badge: "/icons/icon-48.png?v=neon-q-2",
      requireInteraction: true,
      renotify: true,
      data: { kind: "keys" },
    });
    return;
  }

  if (data.type === "inbox") {
    // Зелёный колокольчик (брони): нажатие откроет комнату и отметит уведомление прочитанным.
    await self.registration.showNotification(data.title || "Quazar", {
      body: data.body || "",
      tag: data.tag || `quazar-inbox-${data.notification_id || "x"}`,
      icon: "/icons/icon-192.png?v=neon-q-2",
      badge: "/icons/icon-48.png?v=neon-q-2",
      data: { kind: "inbox", starId: data.star_id || null, channelId: data.channel_id || null, messageId: data.notification_id || null },
    });
    return;
  }

  if (data.type === "star_message") {
    // Сообщение Спутника: упоминание, ответ мне или всё подряд — по уровню уведомлений.
    const text = data.body || "";
    await showGroupedMessage(data, data.title || "Quazar", `quazar-star-${data.channel_id || "x"}`,
      data.message_id ? `quazar-star-message-${data.message_id}` : null,
      (count) => (count > 1 ? `${text}\nи ещё ${count - 1}` : text), {
        icon: "/icons/icon-192.png?v=neon-q-2",
        badge: "/icons/icon-48.png?v=neon-q-2",
        data: { kind: "star", starId: data.star_id || null, channelId: data.channel_id || null, messageId: data.message_id || null, threadId: data.thread_id || null },
      });
    return;
  }

  if (data.type === "chat_message") {
    // Текст личных сообщений зашифрован — в уведомлении только «Новое сообщение», поэтому пачку
    // из одного чата показываем одним уведомлением со счётчиком.
    await showGroupedMessage(data, data.title || "Quazar", `quazar-chat-${data.chat_id || data.message_id}`,
      data.message_id ? `quazar-message-${data.message_id}` : null,
      (count) => (count > 1 ? `Новых сообщений: ${count}` : data.body || "Новое сообщение"), {
        icon: "/icons/icon-192.png?v=neon-q-2", badge: "/icons/icon-48.png?v=neon-q-2",
        data: { kind: "message", chatId: data.chat_id || null },
      });
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
  await self.registration.showNotification(title, options);
}

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

  if (data.kind === "keys") {
    // Приложение, вернувшись на экран, само подхватит запрос и спросит «Это вы входите?».
    event.waitUntil(openOrFocus("/", null));
    return;
  }

  if (data.kind === "inbox") {
    // id уведомления — в messageId (так же его передаёт страница и десктоп).
    const params = new URLSearchParams();
    if (data.messageId) params.set("inbox", data.messageId);
    if (data.starId && data.channelId) {
      params.set("star", data.starId);
      params.set("channel", data.channelId);
    }
    event.waitUntil(
      openOrFocus(`/?${params.toString()}`, {
        type: "quazar-open-inbox",
        notificationId: data.messageId || null,
        starId: data.starId || null,
        channelId: data.channelId || null,
      })
    );
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
