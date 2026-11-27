import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
});
vi.mock("../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { describeShare, localFileUrl, pullShare, resetAndroidShare, startAndroidShare, useShareStore } = await import("../androidShare");
const { default: ShareDialog } = await import("../../components/chat/ShareDialog");
const { useChatStore } = await import("../../store/chat");
const { useAuthStore } = await import("../../store/auth");

type Share = { text?: string; files?: { path: string; name: string; type: string; size: number }[]; skipped?: string[] };
function fakePlugin(share: Share) {
  let listener: (() => void) | null = null;
  const plugin = {
    share,
    take: vi.fn(async () => plugin.share),
    release: vi.fn(async () => { plugin.share = {}; }),
    addListener: vi.fn((_event: string, cb: () => void) => { listener = cb; return { remove() {} }; }),
    emit: () => listener?.(),
  };
  return plugin;
}

/** Файлы приложения: что отдаёт /_capacitor_file_/… */
const disk = new Map<string, string>();
const fetchMock = vi.fn(async (url: string) =>
  disk.has(url) ? new Response(disk.get(url)!, { status: 200 }) : new Response("", { status: 404 }));
vi.stubGlobal("fetch", fetchMock);

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const file = (path: string, name: string, type: string) => ({ path, name, type, size: 3 });

beforeEach(() => {
  resetAndroidShare();
  disk.clear();
  fetchMock.mockClear();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe("присланное из другого приложения", () => {
  it("файлы читаются с того же сайта, копии удаляются, всё ждёт выбора чата", async () => {
    disk.set("/_capacitor_file_/data/cache/shared/1-0", "jpg");
    disk.set("/_capacitor_file_/data/cache/shared/1-1", "pdf");
    const plugin = fakePlugin({
      text: "  Смотри  ",
      files: [file("/data/cache/shared/1-0", "кот.jpg", "image/jpeg"), file("/data/cache/shared/1-1", "отчёт.pdf", "application/pdf"),
        file("/data/cache/shared/1-2", "пропал.txt", "text/plain")],
      skipped: ["огромное.mp4"],
    });
    await pullShare(plugin);
    // Копии остаются, пока не выбран чат: страница может перезагрузиться и забрать их заново.
    expect(plugin.release).not.toHaveBeenCalled();
    const incoming = useShareStore.getState().incoming!;
    expect(incoming.text).toBe("Смотри");
    expect(incoming.files.map((f) => [f.name, f.type])).toEqual([["кот.jpg", "image/jpeg"], ["отчёт.pdf", "application/pdf"]]);
    expect(await incoming.files[0].text()).toBe("jpg");
    // Не прочиталось — так же, как больше 50 МБ: человек увидит, что не добавлено.
    expect(incoming.skipped).toEqual(["огромное.mp4", "пропал.txt"]);
    useShareStore.getState().deliver("chat-1");
    expect(plugin.release).toHaveBeenCalledTimes(1);
    expect(useShareStore.getState().delivery?.files).toHaveLength(2);
  });

  it("закрыли окно — копии тоже удаляются", async () => {
    const plugin = fakePlugin({ text: "заметка" });
    await pullShare(plugin);
    useShareStore.getState().dismiss();
    expect(plugin.release).toHaveBeenCalledTimes(1);
    useShareStore.getState().dismiss();
    expect(plugin.release).toHaveBeenCalledTimes(1);
    // Ни один файл не прочитался — окно всё равно скажет, что не добавлено.
    const broken = fakePlugin({ files: [file("/nope", "видео.mp4", "video/mp4")] });
    await pullShare(broken);
    expect(useShareStore.getState().incoming).toEqual({ text: "", files: [], skipped: ["видео.mp4"] });
    useShareStore.getState().dismiss();
    expect(broken.release).toHaveBeenCalledTimes(1);
  });

  it("пустой ответ ничего не открывает (событие пришло дважды)", async () => {
    const plugin = fakePlugin({});
    await pullShare(plugin);
    expect(useShareStore.getState().incoming).toBeNull();
    expect(plugin.release).not.toHaveBeenCalled();
  });

  it("запуск в приложении забирает готовое и следующее по событию; в браузере ничего", async () => {
    startAndroidShare();
    expect(useShareStore.getState().incoming).toBeNull();

    resetAndroidShare();
    const plugin = fakePlugin({ text: "https://example.com/a" });
    (window as unknown as { Capacitor: unknown }).Capacitor = { getPlatform: () => "android", Plugins: { QuazarShare: plugin } };
    startAndroidShare();
    startAndroidShare();
    await flush();
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
    expect(useShareStore.getState().incoming?.text).toBe("https://example.com/a");

    // Пока не отправили, прислали другое — заменяет.
    plugin.share = { text: "второе" };
    plugin.emit();
    await flush();
    expect(useShareStore.getState().incoming?.text).toBe("второе");
  });

  it("выбранный чат забирает присланное один раз и только свой", () => {
    useShareStore.setState({ incoming: { text: "привет", files: [], skipped: [] } });
    useShareStore.getState().deliver("chat-1");
    expect(useShareStore.getState().incoming).toBeNull();
    expect(useShareStore.getState().takeDelivery("chat-2")).toBeNull();
    expect(useShareStore.getState().takeDelivery("chat-1")?.text).toBe("привет");
    expect(useShareStore.getState().takeDelivery("chat-1")).toBeNull();
  });

  it("описание и адрес файла", () => {
    const f = (type: string) => new File(["x"], "f", { type });
    expect(describeShare({ text: "", files: [f("image/png"), f("image/jpeg"), f("video/mp4"), f("application/zip")], skipped: [] }))
      .toBe("2 фото, 1 видео, 1 файл");
    expect(describeShare({ text: "https://quazar-msg.ru", files: [], skipped: [] })).toBe("ссылка");
    expect(describeShare({ text: "заметка", files: [f("a/b"), f("a/b"), f("a/b"), f("a/b"), f("a/b")], skipped: [] })).toBe("5 файлов, текст");
    expect(localFileUrl("/data/user/0/ru.quazarmsg.app/cache/shared/3-0")).toBe("/_capacitor_file_/data/user/0/ru.quazarmsg.app/cache/shared/3-0");
    expect(localFileUrl("/a b/#1")).toBe("/_capacitor_file_/a%20b/%231");
  });
});

describe("окно «Отправить в…»", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAuthStore.setState({ user: { id: "me", username: "me" } as never });
    useChatStore.setState({ chats: [
      { id: "saved", type: "saved", name: null, members: [] },
      { id: "c-bob", type: "direct", name: null, members: [{ user: { id: "me", username: "me" } }, { user: { id: "bob", username: "bob", display_name: "Боб" } }] },
    ] as never });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  const rows = () => [...document.querySelectorAll("button")].map((b) => b.textContent);

  it("выбрали чат — он открывается и получает присланное", async () => {
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent<{ chatId: string }>).detail.chatId);
    window.addEventListener("quazar-open-chat", onOpen);
    act(() => root.render(createElement(ShareDialog)));
    expect(document.body.textContent).not.toContain("Отправить в…");

    const pdf = new File(["x"], "отчёт.pdf", { type: "application/pdf" });
    act(() => useShareStore.setState({ incoming: { text: "", files: [pdf], skipped: ["кино.mkv"] } }));
    expect(document.body.textContent).toContain("Отправить в…");
    expect(document.body.textContent).toContain("1 файл");
    expect(document.body.textContent).toContain("Не добавлено (больше 50 МБ или не открылось): кино.mkv");
    expect(document.body.textContent).toContain("Файлы отправятся, как только выберете чат");
    expect(rows()).toEqual(["✕", "Записная книжка", "БОБоб"]);
    const bob = [...document.querySelectorAll("button")].find((b) => b.textContent?.endsWith("Боб"))!;
    await act(async () => bob.click());
    expect(opened).toEqual(["c-bob"]);
    expect(useShareStore.getState().delivery).toMatchObject({ chatId: "c-bob", files: [pdf] });
    expect(document.body.textContent).not.toContain("Отправить в…");
    window.removeEventListener("quazar-open-chat", onOpen);
  });

  it("закрыли окно — присланное забыто", () => {
    act(() => useShareStore.setState({ incoming: { text: "заметка", files: [], skipped: [] } }));
    act(() => root.render(createElement(ShareDialog)));
    expect(document.body.textContent).toContain("заметка");
    expect(document.body.textContent).toContain("Откроется чат: можно дописать сообщение");
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Закрыть"]')!;
    act(() => close.click());
    expect(useShareStore.getState().incoming).toBeNull();
    expect(useShareStore.getState().delivery).toBeNull();
  });
});
