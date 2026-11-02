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

interface ScreenAudioState extends Preferences {
  setShareAudio: (enabled: boolean) => void;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
}

export const useScreenAudio = create<ScreenAudioState>((set) => {
  const update = (patch: Partial<Preferences>) => set((state) => {
    const next = { shareAudio: state.shareAudio, enabled: state.enabled, volume: state.volume, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Настройка действует и без хранилища. */ }
    return next;
  });
  return { ...load(), setShareAudio: (shareAudio) => update({ shareAudio }),
    setEnabled: (enabled) => update({ enabled }),
    setVolume: (volume) => { if (Number.isFinite(volume)) update({ volume: Math.max(0, Math.min(1, volume)) }); } };
});

export function screenAudioVolume(): number {
  const { enabled, volume } = useScreenAudio.getState();
  return enabled ? volume : 0;
}
