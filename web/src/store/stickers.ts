import { create } from "zustand";
import { stickersApi, type StickerInfo, type StickerPack } from "../api/stickers";
import { parseSticker, stickerPreview } from "../stickers/format";

interface StickersState {
  packs: StickerPack[];
  loaded: boolean;
  /** «pack/id» → стикер. */
  byKey: Record<string, StickerInfo>;
  load: () => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useStickersStore = create<StickersState>((set) => ({
  packs: [],
  loaded: false,
  byKey: {},
  load: () => {
    loading ??= stickersApi
      .myPacks()
      .then((packs) => {
        const byKey: Record<string, StickerInfo> = {};
        for (const p of packs) for (const st of p.stickers) byKey[`${p.id}/${st.id}`] = st;
        set({ packs, byKey, loaded: true });
      })
      .catch(() => {
        // Попробуем ещё раз при следующем открытии панели.
        loading = null;
      });
    return loading;
  },
}));

export function findSticker(pack: string, id: string): StickerInfo | undefined {
  return useStickersStore.getState().byKey[`${pack}/${id}`];
}

/** Текст сообщения для превью: стикер → «Стикер 😂», остальное как есть. */
export function messagePreview(payload: string): string {
  const ref = parseSticker(payload);
  if (!ref) return payload;
  return stickerPreview(findSticker(ref.pack, ref.id)?.emoji);
}
