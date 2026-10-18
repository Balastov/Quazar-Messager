import { http } from "./client";

export interface StickerInfo {
  id: string;
  emoji: string;
  /** Путь от корня API (без /api). */
  url: string;
}

export interface StickerPack {
  id: string;
  version: number;
  title: string;
  author: string;
  license: string;
  license_url: string;
  source_url: string;
  stickers: StickerInfo[];
}

export const stickersApi = {
  /** Установленные паки (паки по умолчанию есть у всех). */
  myPacks: () => http.get<StickerPack[]>("/stickers/packs").then((r) => r.data),
};

/** Полный адрес анимации: в вебе API живёт под /api. */
export function stickerFileUrl(sticker: StickerInfo): string {
  return `${http.defaults.baseURL ?? ""}${sticker.url}`;
}
