import {afterEach, beforeEach, expect, it, vi} from "vitest";

vi.mock("../../store/presence", () => ({isDoNotDisturb: () => controls.dnd}));
vi.mock("../sound", () => ({playSoftChime: vi.fn()}));
const controls = vi.hoisted(() => ({dnd: false}));
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value)});
const {notifyIncomingMessage, notifyStarMessage} = await import("../notify");
const {useToastStore} = await import("../toastStore");
const {setNotifyPrefs} = await import("../prefs");
const {playSoftChime} = await import("../sound");
const {http} = await import("../../api/client");
const {setNotificationUser, setPushEndpoint, pushWasShown, acknowledgeMessage} = await import("../delivery");
let focus: boolean, visibility: string;
let restoreVisibility: () => void;
let show: ReturnType<typeof vi.fn>, fallback: ReturnType<typeof vi.fn>;
const star = (id: string) => ({title: "Алиса · #общий", body: "Сообщение", starId: "star", channelId: "channel", messageId: id});

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); memory.clear(); controls.dnd = false;
  vi.stubGlobal("localStorage", {getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value)});
  setNotificationUser(null); setNotificationUser("me");
  useToastStore.setState({toasts: []});
  focus = true; visibility = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focus);
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => visibility});
  restoreVisibility = () => {if (original) Object.defineProperty(document, "visibilityState", original); else Reflect.deleteProperty(document, "visibilityState");};
  show = vi.fn().mockResolvedValue(undefined); fallback = vi.fn();
  vi.stubGlobal("Notification", class {
    static permission = "granted";
    constructor(title: string, options: NotificationOptions) {fallback(title, options);}
  });
  const reg = {active: {}, showNotification: show};
  vi.stubGlobal("navigator", {serviceWorker: {ready: Promise.resolve(reg), getRegistration: vi.fn().mockResolvedValue(reg)}});
});
afterEach(() => {setNotificationUser(null); restoreVisibility(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();});

it("shows toast and sound in the foreground and stays quiet in the active chat", async () => {
  await notifyStarMessage(star("foreground"));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  expect(playSoftChime).toHaveBeenCalledOnce();
  expect(show).not.toHaveBeenCalled();
  await notifyIncomingMessage({title: "Боб", body: "Текст", chatId: "chat", isActiveChat: true, messageId: "active"});
  expect(useToastStore.getState().toasts).toHaveLength(1);
});

it("notifies an unfocused visible window and uses the message tag shared with push", async () => {
  focus = false;
  await notifyStarMessage(star("unfocused"));
  expect(show).toHaveBeenCalledWith("Алиса · #общий", expect.objectContaining({tag: "quazar-star-message-unfocused", silent: false, renotify: false}));
  expect(useToastStore.getState().toasts).toHaveLength(0);
  expect(playSoftChime).not.toHaveBeenCalled();
});

it("honors device sound preferences in background chat notifications", async () => {
  focus = false; visibility = "hidden"; setNotifyPrefs({sound: false});
  await notifyIncomingMessage({title: "Боб", body: "Текст", chatId: "chat", isActiveChat: false, messageId: "background"});
  expect(show).toHaveBeenCalledWith("Боб", expect.objectContaining({tag: "quazar-message-background", silent: true}));
  expect(playSoftChime).not.toHaveBeenCalled();
});

it("does not repeat duplicate websocket or already displayed push messages", async () => {
  await notifyStarMessage(star("same")); await notifyStarMessage(star("same"));
  pushWasShown("from-push", "me"); await notifyStarMessage(star("from-push"));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  expect(playSoftChime).toHaveBeenCalledOnce();
});

it("preserves explicit disable and do-not-disturb", async () => {
  setNotifyPrefs({enabled: false}); await notifyStarMessage(star("disabled"));
  setNotifyPrefs({enabled: true}); controls.dnd = true; await notifyStarMessage(star("dnd"));
  expect(show).not.toHaveBeenCalled(); expect(playSoftChime).not.toHaveBeenCalled();
  expect(useToastStore.getState().toasts).toHaveLength(0);
});

it("falls back when serviceWorker.ready never resolves", async () => {
  focus = false; visibility = "hidden";
  vi.stubGlobal("navigator", {serviceWorker: {ready: new Promise(() => {}), getRegistration: vi.fn().mockResolvedValue(undefined)}});
  const pending = notifyStarMessage(star("no-worker"));
  await vi.advanceTimersByTimeAsync(1000); await pending;
  expect(fallback).toHaveBeenCalledOnce();
});

it("does not display an old account's delayed notification after logout", async () => {
  focus = false;
  vi.stubGlobal("navigator", {serviceWorker: {ready: new Promise(() => {}), getRegistration: vi.fn().mockResolvedValue(undefined)}});
  const pending = notifyStarMessage(star("old-user"));
  setNotificationUser(null);
  await vi.advanceTimersByTimeAsync(1000); await pending;
  expect(fallback).not.toHaveBeenCalled(); expect(playSoftChime).not.toHaveBeenCalled();
});

it("batches acknowledgements only for a device that processed the message", async () => {
  setPushEndpoint("https://push.example/device");
  const post = vi.spyOn(http, "post").mockResolvedValue({data: {ok: true}});
  focus = false; acknowledgeMessage("not-processed");
  acknowledgeMessage("displayed", true); acknowledgeMessage("displayed", true);
  focus = true; acknowledgeMessage("in-app");
  await vi.advanceTimersByTimeAsync(100);
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith("/push/ack", {endpoint: "https://push.example/device", message_ids: ["displayed", "in-app"]});
});

it("ignores notifications belonging to a previous account after a session switch", async () => {
  setNotificationUser("next-user");
  await notifyIncomingMessage({title: "Old private sender", body: "Private", chatId: "old-chat", messageId: "old-message", recipientId: "me", isActiveChat: false});
  expect(useToastStore.getState().toasts).toHaveLength(0);
  expect(show).not.toHaveBeenCalled(); expect(playSoftChime).not.toHaveBeenCalled();
});
