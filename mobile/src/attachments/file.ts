/**
 * Файл «FILE1:{json}» (формат — web/src/attachments/file.ts). Скачивать в приложении пока нечем —
 * нужна нативная библиотека для сохранения файлов; показываем плашку с названием и размером.
 */
export const FILE_PREFIX = 'FILE1:';

export interface FileInfo {
  name: string;
  size: number;
}

export function parseFile(payload: string): FileInfo | null {
  if (!payload.startsWith(FILE_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(payload.slice(FILE_PREFIX.length));
    return typeof raw?.id === 'string' && typeof raw.name === 'string' && Number.isFinite(raw.size)
      ? {name: raw.name.slice(0, 255), size: raw.size}
      : null;
  } catch {
    return null;
  }
}

/** 1536 → «1,5 КБ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace('.', ',');
  return `${text.replace(/,0$/, '')} ${units[unit]}`;
}

export function filePreview(file: FileInfo): string {
  return `📎 ${file.name}`;
}
