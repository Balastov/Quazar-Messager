export type ScreenMode = "detail" | "motion";
type CaptureOptions = DisplayMediaStreamOptions & {
  systemAudio: "include" | "exclude";
  windowAudio: "window" | "exclude";
  selfBrowserSurface: "exclude";
  surfaceSwitching: "include";
};

export const NO_SCREEN_AUDIO = "Браузер не передал звук выбранного источника. Если в окне выбора есть пункт передачи звука, включите его; либо выберите другой источник, например вкладку браузера.";

/** Только звук выбранного источника — микрофон вместо него никогда не запрашиваем. */
export async function captureScreen(shareAudio: boolean, mode: ScreenMode = "detail"): Promise<MediaStream> {
  const options: CaptureOptions = {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: mode === "motion" ? 30 : 15, max: mode === "motion" ? 30 : 15 } },
    audio: shareAudio,
    systemAudio: shareAudio ? "include" : "exclude",
    windowAudio: shareAudio ? "window" : "exclude",
    selfBrowserSurface: "exclude", surfaceSwitching: "include",
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const video = stream.getVideoTracks()[0];
  if (!video) { stream.getTracks().forEach((track) => track.stop()); throw new Error("Экран не выбран"); }
  video.contentHint = mode;
  if (!shareAudio) {
    for (const track of stream.getAudioTracks()) { track.stop(); stream.removeTrack(track); }
  }
  return stream;
}
