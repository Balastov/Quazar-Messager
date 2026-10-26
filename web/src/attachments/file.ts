/**
 * Файл в сообщении чата — текст «FILE1:{json}» со ссылкой на вложение и ключом к нему.
 * Файл шифруется так же, как картинка (attachments/image.ts → encryptFile): в личных чатах
 * сервер не видит ни содержимого, ни названия.
 */
export const FILE_PREFIX = "FILE1:";
/** Столько принимает сервер (и в чатах, и в Спутниках). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface FileRef {
  /** id вложения на сервере. */
  id: string;
  /** base64 ключа secretbox (32 байта). */
  key: string;
  name: string;
  /** Тип со слов отправителя — только для значка; скачиваем всегда как octet-stream. */
  mime: string;
  size: number;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeFile(ref: FileRef): string {
  return FILE_PREFIX + JSON.stringify(ref);
}

export function parseFile(payload: string): FileRef | null {
  if (!payload.startsWith(FILE_PREFIX)) return null;
  try {
    const raw = JSON.parse(payload.slice(FILE_PREFIX.length));
    if (
      typeof raw?.id !== "string" || !ID_RE.test(raw.id) ||
      typeof raw.key !== "string" ||
      typeof raw.name !== "string" ||
      !Number.isFinite(raw.size) || raw.size < 0
    ) {
      return null;
    }
    return {
      id: raw.id,
      key: raw.key,
      name: cleanFileName(raw.name),
      mime: typeof raw.mime === "string" ? raw.mime.slice(0, 127) : "",
      size: raw.size,
    };
  } catch {
    return null;
  }
}

/** Имя без путей и управляющих символов — его же предложим при сохранении. */
export function cleanFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+|\.+$/g, "");
  return (clean || "file").slice(0, 255);
}

export function filePreview(ref: { name: string }): string {
  return `📎 ${ref.name}`;
}

/** 1536 → «1,5 КБ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(".", ",");
  return `${text.replace(/,0$/, "")} ${units[unit]}`;
}

const ICONS: [RegExp, string][] = [
  [/\.(pdf)$/i, "📕"],
  [/\.(docx?|odt|rtf|pages)$/i, "📝"],
  [/\.(xlsx?|ods|csv|numbers)$/i, "📊"],
  [/\.(pptx?|odp|key)$/i, "📽"],
  [/\.(zip|rar|7z|tar|gz|bz2|xz)$/i, "🗜"],
  [/\.(jpe?g|png|gif|webp|heic|bmp|svg|tiff?)$/i, "🖼"],
  [/\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i, "🎵"],
  [/\.(mp4|mov|mkv|webm|avi)$/i, "🎬"],
  [/\.(txt|md|log)$/i, "📄"],
  [/\.(js|ts|tsx|py|java|go|rs|c|cpp|h|json|ya?ml|sql|sh|html|css)$/i, "🧩"],
];

export function fileIcon(name: string): string {
  return ICONS.find(([re]) => re.test(name))?.[1] ?? "📎";
}

/** Отдать байты браузеру «Сохранить как». Тип — octet-stream: файл не откроется как страница. */
export function saveBytes(bytes: Uint8Array | Blob, name: string): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = cleanFileName(name);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
