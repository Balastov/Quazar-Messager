/** Проверяем, что браузер может прочитать загруженный ролик, до отправки на сервер. */
export function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      const duration = video.duration;
      clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null;
      video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
      if (error) reject(new Error(error));
      else resolve(duration);
    };
    const timer = setTimeout(() => finish("Не удалось прочитать видео. Попробуйте другой файл."), 15000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 86400) {
        finish("Не удалось определить длительность ролика или он длиннее суток.");
      } else finish();
    };
    video.onerror = () => finish("Браузер не поддерживает этот ролик. Попробуйте MP4 с H.264 или WebM.");
    video.src = url;
  });
}
