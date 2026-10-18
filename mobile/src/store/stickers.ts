import {create} from 'zustand';
import {stickersApi, type StickerInfo, type StickerPack} from '../api/stickers';

interface StickersState {
  packs: StickerPack[];
  loaded: boolean;
  /** «pack/id» → стикер. */
  byKey: Record<string, StickerInfo>;
  load: () => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useStickersStore = create<StickersState>(set => ({
  packs: [],
  loaded: false,
  byKey: {},
  load: () => {
    loading ??= stickersApi
      .myPacks()
      .then(packs => {
        const byKey: Record<string, StickerInfo> = {};
        for (const p of packs) {
          for (const st of p.stickers) {
            byKey[`${p.id}/${st.id}`] = st;
          }
        }
        set({packs, byKey, loaded: true});
      })
      .catch(() => {
        loading = null;
      });
    return loading;
  },
}));
