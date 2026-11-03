import source from "../../../public/sw.js?raw";
import {expect, it, vi} from "vitest";

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const show = vi.fn().mockResolvedValue(undefined), post = vi.fn(), focus = vi.fn().mockResolvedValue(undefined);
  const self = {addEventListener: (name: string, handler: (event: any) => void) => {handlers[name] = handler;},
    registration: {scope: "https://quazar-msg.ru/", showNotification: show},
    clients: {matchAll: vi.fn().mockResolvedValue([{url: "https://quazar-msg.ru/", postMessage: post, focus}])}};
  new Function("self", source)(self);
  const push = async (data: object) => {
    const pending: Promise<unknown>[] = [];
    handlers.push({data: {json: () => data}, waitUntil: (promise: Promise<unknown>) => pending.push(promise)});
    await Promise.all(pending);
  };
  return {handlers, show, post, focus, push};
}

it("always displays incoming star push, honors silence and reports the message id", async () => {
  const w = worker();
  const payload = {type: "star_message", title: "Звезда", message_id: "m1", star_id: "star", channel_id: "channel",
    tag: "quazar-star-message-m1", recipient_user_id: "me", silent: true};
  await w.push(payload); await w.push(payload);
  expect(w.show).toHaveBeenCalledTimes(2);
  expect(w.show).toHaveBeenLastCalledWith("Звезда", expect.objectContaining({tag: payload.tag, silent: true, renotify: false,
    data: expect.objectContaining({kind: "star", starId: "star", channelId: "channel", messageId: "m1"})}));
  expect(w.post).toHaveBeenCalledWith({type: "quazar-push-shown", messageId: "m1", userId: "me"});
});

it("displays closed-app chat push and opens the correct conversation", async () => {
  const w = worker();
  await w.push({type: "chat_message", title: "Боб", body: "Новое сообщение", message_id: "m2", chat_id: "chat", tag: "quazar-message-m2"});
  const options = w.show.mock.calls[0][1];
  expect(options.data).toEqual({kind: "message", chatId: "chat"});
  const pending: Promise<unknown>[] = [];
  w.handlers.notificationclick({notification: {data: options.data, close: vi.fn()}, waitUntil: (p: Promise<unknown>) => pending.push(p)});
  await Promise.all(pending);
  expect(w.post).toHaveBeenCalledWith({type: "quazar-open-chat", chatId: "chat"});
  expect(w.focus).toHaveBeenCalledOnce();
});

it("preserves the message and thread destination when a star notification is clicked", async () => {
  const w = worker();
  await w.push({type: "star_message", star_id: "guest-star", channel_id: "shared", message_id: "reply", thread_id: "root"});
  const pending: Promise<unknown>[] = [];
  w.handlers.notificationclick({notification: {data: w.show.mock.calls[0][1].data, close: vi.fn()}, waitUntil: (p: Promise<unknown>) => pending.push(p)});
  await Promise.all(pending);
  expect(w.post).toHaveBeenCalledWith({type: "quazar-open-star", starId: "guest-star", channelId: "shared", messageId: "reply", threadId: "root"});
});
