import { create } from "zustand";

const KEY = "quazar-screen-audio";
interface Preferences { shareAudio: boolean; enabled: boolean; volume: number }
const defaults: Preferences = { shareAudio: false, enabled: true, volume: 1 };

function load(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { shareAudio: typeof value.shareAudio === "boolean" ? value.shareAudio : defaults.shareAudio,
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      volume: typeof value.volume === "number" && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : 1 };
  } catch { return defaults; }
}

/** Свой звук у каждого показа, когда их два (на время разговора, не сохраняется). */
export interface SharerAudio { enabled: boolean; volume: number }

interface ScreenAudioState extends Preferences {
  bySharer: Record<string, SharerAudio>;
  setShareAudio: (enabled: boolean) => void;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  setSharerAudio: (userId: string, patch: Partial<SharerAudio>) => void;
}

export const useScreenAudio = create<ScreenAudioState>((set) => {
  const update = (patch: Partial<Preferences>) => set((state) => {
    const next = { shareAudio: state.shareAudio, enabled: state.enabled, volume: state.volume, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Настройка действует и без хранилища. */ }
    return next;
  });
  return { ...load(), bySharer: {}, setShareAudio: (shareAudio) => update({ shareAudio }),
    // Общая настройка снова управляет всеми показами: отдельные (от двух показов) сбрасываются.
    setEnabled: (enabled) => { update({ enabled }); set({ bySharer: {} }); },
    setVolume: (volume) => {
      if (!Number.isFinite(volume)) return;
      update({ volume: Math.max(0, Math.min(1, volume)) });
      set({ bySharer: {} });
    },
    setSharerAudio: (userId, patch) => set((state) => {
      const current = sharerAudio(state, userId);
      const volume = patch.volume === undefined || !Number.isFinite(patch.volume) ? current.volume : Math.max(0, Math.min(1, patch.volume));
      return { bySharer: { ...state.bySharer, [userId]: { enabled: patch.enabled ?? current.enabled, volume } } };
    }) };
});

/** Звук показа этого человека: своя настройка, а пока её нет — общая. */
export function sharerAudio(state: Pick<ScreenAudioState, "enabled" | "volume" | "bySharer">, userId?: string): SharerAudio {
  return (userId && state.bySharer[userId]) || { enabled: state.enabled, volume: state.volume };
}

export function screenAudioVolume(userId?: string): number {
  const { enabled, volume } = sharerAudio(useScreenAudio.getState(), userId);
  return enabled ? volume : 0;
}
