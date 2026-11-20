import { useEffect, useRef } from "react";
import type { Track } from "livekit-client";

/**
 * Видео с камеры участника комнаты. LiveKit сам выбирает слой качества по размеру элемента
 * (adaptiveStream): в сетке приходит маленький, в развёрнутом виде — 720p.
 * Свою камеру показываем зеркально — как в зеркале привычнее; другим она уходит как есть.
 */
export default function PeerVideo({ track, mirror, className }: { track: Track; mirror: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}
