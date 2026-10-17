import { create } from "zustand";
import {
  canSelectOutput,
  canSwitchIosRoute,
  getIosRoute,
  getPreferredInput,
  getPreferredOutput,
  listAudioDevices,
  setIosRoute as saveIosRoute,
  setPreferredInput,
  setPreferredOutput,
  type AudioDevice,
  type IosRoute,
} from "../calls/devices";
import { useCallStore } from "./call";
import { useVoiceStore } from "./voice";

interface DevicesState {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  labelsHidden: boolean;
  /** "" — по умолчанию (системное устройство). */
  input: string;
  output: string;
  outputSupported: boolean;
  iosRouteSupported: boolean;
  iosRoute: IosRoute;

  refresh: () => Promise<void>;
  /** Разрешить микрофон, чтобы браузер показал названия устройств. */
  unlockLabels: () => Promise<void>;
  setInput: (deviceId: string) => Promise<void>;
  setOutput: (deviceId: string) => Promise<void>;
  setIosRoute: (route: IosRoute) => void;
}

export const useDevicesStore = create<DevicesState>((set, get) => {
  if (typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
    // Подключили или вынули гарнитуру — обновляем список.
    navigator.mediaDevices.addEventListener("devicechange", () => void get().refresh());
  }

  return {
    inputs: [],
    outputs: [],
    labelsHidden: false,
    input: getPreferredInput(),
    output: getPreferredOutput(),
    outputSupported: canSelectOutput(),
    iosRouteSupported: canSwitchIosRoute(),
    iosRoute: getIosRoute(),

    refresh: async () => {
      try {
        set(await listAudioDevices());
      } catch {
        // ignore
      }
    },

    unlockLabels: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // человек не разрешил — останутся «Микрофон 1, 2…»
      }
      await get().refresh();
    },

    setInput: async (deviceId) => {
      setPreferredInput(deviceId);
      set({ input: deviceId });
      // Применяем на ходу: и на Планете, и в личном звонке.
      await Promise.all([
        useVoiceStore.getState().switchMicrophone(),
        useCallStore.getState().switchMicrophone(),
      ]);
    },

    setOutput: async (deviceId) => {
      setPreferredOutput(deviceId);
      set({ output: deviceId });
      await useVoiceStore.getState().applyOutput();
    },

    setIosRoute: (route) => {
      saveIosRoute(route);
      set({ iosRoute: route });
    },
  };
});
