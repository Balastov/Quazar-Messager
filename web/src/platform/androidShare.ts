/**
 * «Поделиться» → Quazar в приложении для Android (2.13.0+, нативный модуль QuazarShare).
 *
 * Приложение копирует присланные файлы к себе и шлёт событие «share»; здесь мы забираем их по
 * адресу /_capacitor_file_/… (Capacitor отдаёт такие пути на том же сайте) и складываем в File.
 * Дальше человек выбирает чат (ShareDialog) — тогда приложение удаляет копии, — и чат подставляет
 * текст в поле, картинки — в лоток к сообщению, остальные файлы отправляет, как при перетаскивании.
 *
 * В браузере и в старых версиях приложения модуля нет — всё это молча не работает.
 */
import { create } from "zustand";
import type { ListenerHandle } from "./android";

export interface SharedFileRef {
  path: string;
  name: string;
  type: string;
  size: number;
}

export interface NativeShare {
  text?: string;
  files?: SharedFileRef[];
  skipped?: string[];
}

export interface AndroidSharePlugin {
  take(): Promise<NativeShare>;
  release(): Promise<void>;
  addListener(event: "share", callback: () => void): ListenerHandle | Promise<ListenerHandle>;
}

interface CapacitorGlobal {
  getPlatform?(): string;
  Plugins?: { QuazarShare?: AndroidSharePlugin };
}

export function androidSharePlugin(): AndroidSharePlugin | undefined {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (cap?.getPlatform?.() !== "android") return undefined;
  return cap.Plugins?.QuazarShare;
}

/** Присланное, готовое к отправке. */
export interface IncomingShare {
  text: string;
  files: File[];
  /** Файлы, которые не удалось взять: больше 50 МБ, не прочитались, слишком много. */
  skipped: string[];
}

interface ShareState {
  /** Пришло и ждёт выбора чата. */
  incoming: IncomingShare | null;
  /** Чат выбран: окно этого чата заберёт присланное, когда будет готово принимать. */
  delivery: (IncomingShare & { chatId: string }) | null;
  deliver: (chatId: string) => void;
  dismiss: () => void;
  takeDelivery: (chatId: string) => IncomingShare | null;
}

/** Копии в приложении держим, пока человек не выбрал чат или не закрыл окно: страница может
 *  перезагрузиться (вход, обновление), и тогда присланное заберём заново. */
let releaseCopies: (() => void) | null = null;

function releaseNative() {
  const release = releaseCopies;
  releaseCopies = null;
  release?.();
}

export const useShareStore = create<ShareState>((set, get) => ({
  incoming: null,
  delivery: null,
  deliver: (chatId) => {
    const incoming = get().incoming;
    if (!incoming) return;
    set({ incoming: null, delivery: { ...incoming, chatId } });
    releaseNative();
  },
  dismiss: () => {
    set({ incoming: null });
    releaseNative();
  },
  takeDelivery: (chatId) => {
    const delivery = get().delivery;
    if (!delivery || delivery.chatId !== chatId) return null;
    set({ delivery: null });
    return { text: delivery.text, files: delivery.files, skipped: delivery.skipped };
  },
}));

/** Картинки, которые чат кладёт в лоток (остальное уходит файлами). */
export const TRAY_IMAGE = /^image\/(jpeg|png|gif|webp)$/;

/** Краткое описание присланного для окна выбора чата. */
export function describeShare(share: IncomingShare): string {
  const images = share.files.filter((f) => TRAY_IMAGE.test(f.type)).length;
  const videos = share.files.filter((f) => f.type.startsWith("video/")).length;
  const others = share.files.length - images - videos;
  const parts: string[] = [];
  if (images) parts.push(plural(images, "фото", "фото", "фото"));
  if (videos) parts.push(plural(videos, "видео", "видео", "видео"));
  if (others) parts.push(plural(others, "файл", "файла", "файлов"));
  if (share.text) parts.push(/^https?:\/\/\S+$/.test(share.text) ? "ссылка" : "текст");
  return parts.join(", ");
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

/** Файл приложения по адресу того же сайта: Capacitor отдаёт его сам, в сеть запрос не уходит. */
export function localFileUrl(path: string): string {
  return `/_capacitor_file_${path.startsWith("/") ? "" : "/"}${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function readFile(ref: SharedFileRef): Promise<File | null> {
  try {
    const response = await fetch(localFileUrl(ref.path));
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], ref.name || "файл", { type: ref.type || blob.type || "application/octet-stream" });
  } catch {
    return null;
  }
}

let started = false;
let busy: Promise<void> | null = null;

/** Забрать присланное у приложения. Пусто — ничего не делаем (событие могло прийти дважды). */
export async function pullShare(plugin: AndroidSharePlugin): Promise<void> {
  const share = await plugin.take();
  const refs = Array.isArray(share?.files) ? share.files : [];
  const text = typeof share?.text === "string" ? share.text.trim() : "";
  if (!refs.length && !text) return;
  const skipped = Array.isArray(share.skipped) ? share.skipped.filter((n) => typeof n === "string") : [];
  const files: File[] = [];
  for (const ref of refs) {
    const file = await readFile(ref);
    if (file) files.push(file);
    else skipped.push(ref.name);
  }
  const release = () => void plugin.release().catch(() => {});
  if (!files.length && !text && !skipped.length) { release(); return; }
  // Новое присланное заменяет то, что ещё не отправили (его копии приложение уже удалило).
  releaseCopies = release;
  useShareStore.setState({ incoming: { text, files, skipped }, delivery: null });
}

function pull(plugin: AndroidSharePlugin) {
  // События подряд — забираем по очереди, чтобы не читать одно и то же дважды.
  const run = async () => {
    try { await pullShare(plugin); } catch (err) { console.warn("Android share failed", err); }
  };
  busy = (busy ?? Promise.resolve()).then(run);
}

/** Подписка один раз при запуске страницы: присланное могло и запустить приложение. */
export function startAndroidShare() {
  const plugin = androidSharePlugin();
  if (!plugin || started) return;
  started = true;
  try {
    void Promise.resolve(plugin.addListener("share", () => pull(plugin))).catch(() => {});
  } catch { /* без события — заберём хотя бы то, что уже готово */ }
  pull(plugin);
}

/** Для тестов. */
export function resetAndroidShare() {
  started = false;
  releaseCopies = null;
  busy = null;
  useShareStore.setState({ incoming: null, delivery: null });
}
