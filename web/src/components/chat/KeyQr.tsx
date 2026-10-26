import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { fingerprintMatches, fingerprintQr, parseFingerprintQr } from "../../crypto/fingerprint";
import s from "./Chat.module.css";

/** QR с кодом безопасности — собеседник сканирует его своей камерой. */
export function FingerprintQr({ fingerprint }: { fingerprint: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(fingerprintQr(fingerprint));
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [fingerprint]);
  // SVG собран библиотекой из цифр кода — без пользовательского текста.
  return <div className={s.qr} role="img" aria-label="QR-код для сверки" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export type ScanResult = "match" | "mismatch";

const SCAN_EVERY_MS = 200;

/** Камера ищет QR собеседника и сверяет его код с нашим. */
export function FingerprintScanner({
  fingerprint,
  onResult,
}: {
  fingerprint: string;
  onResult: (result: ScanResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        setError("Нет доступа к камере — разрешите её в настройках браузера или сверьте цифры");
        return;
      }
      const video = videoRef.current;
      if (!video || done) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      timer = setInterval(() => {
        if (!ctx || !video.videoWidth) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (!code) return;
        const scanned = parseFingerprintQr(code.data);
        if (!scanned || done) return;
        done = true;
        onResult(fingerprintMatches(scanned, fingerprint) ? "match" : "mismatch");
      }, SCAN_EVERY_MS);
    })();

    return () => {
      done = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [fingerprint, onResult]);

  if (error) return <p className={s.optionHint}>{error}</p>;
  return (
    <div className={s.scanner}>
      <video ref={videoRef} muted playsInline />
      <span className={s.scannerFrame} />
    </div>
  );
}
