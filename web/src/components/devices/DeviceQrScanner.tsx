import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import s from "./Pairing.module.css";

export default function DeviceQrScanner({ onScan }: { onScan: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null), callback = useRef(onScan); callback.current = onScan;
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, stream: MediaStream | undefined, timer: ReturnType<typeof setInterval> | undefined, done = false;
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    void (async () => {
      try {
        if (!ctx) throw new Error("Canvas unavailable");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 800 } }, audio: false });
        if (!active) { stream.getTracks().forEach(track => track.stop()); return; }
        if (!video.current) return;
        video.current.srcObject = stream; await video.current.play();
        timer = setInterval(() => {
          const frame = video.current;
          if (!active || done || !ctx || !frame?.videoWidth) return;
          canvas.width = Math.min(800, frame.videoWidth); canvas.height = Math.round(frame.videoHeight * canvas.width / frame.videoWidth);
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
          if (result) {
            try { callback.current(result.data); done = true; }
            catch { setError("Это не QR-код входа Quazar. Наведите камеру на код нового устройства"); }
          }
        }, 200);
      } catch {
        stream?.getTracks().forEach(track => track.stop());
        if (active) setError("Нет доступа к камере. Разрешите её в браузере или используйте одноразовый код");
      }
    })();
    return () => { active = false; clearInterval(timer); stream?.getTracks().forEach(track => track.stop()); };
  }, []);
  return <div className={s.stack}><video ref={video} className={s.video} autoPlay muted playsInline aria-label="Сканер QR-кода" />{error && <p className={s.error} role="alert">{error}</p>}</div>;
}
