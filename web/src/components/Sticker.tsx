import { useEffect, useRef, useState } from "react";
import type { AnimationItem, LottiePlayer } from "lottie-web";
import s from "./Sticker.module.css";

interface Props {
  url: string;
  emoji?: string;
  size: number;
  /** loop — играет, пока виден; hover — только под курсором (панель выбора). */
  mode: "loop" | "hover";
}

/** «Лёгкая» сборка lottie-web: без eval, который запрещает CSP. Грузится при первом стикере. */
let lottie: Promise<LottiePlayer> | null = null;
function loadLottie(): Promise<LottiePlayer> {
  lottie ??= import("lottie-web/build/player/lottie_light").then((m) => m.default as LottiePlayer);
  return lottie;
}

/** Текст анимаций: lottie меняет переданный объект, поэтому каждому стикеру — свой JSON.parse. */
const texts = new Map<string, Promise<string>>();
function loadText(url: string): Promise<string> {
  let p = texts.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`sticker ${r.status}`);
      return r.text();
    });
    p.catch(() => texts.delete(url));
    texts.set(url, p);
  }
  return p;
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function Sticker({ url, emoji, size, mode }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    setState("loading");

    void Promise.all([loadLottie(), loadText(url)])
      .then(([player, text]) => {
        if (cancelled) return;
        const anim = player.loadAnimation({
          container: box,
          renderer: "svg",
          loop: true,
          autoplay: false,
          animationData: JSON.parse(text),
          rendererSettings: { preserveAspectRatio: "xMidYMid meet", progressiveLoad: true },
        });
        animRef.current = anim;
        setState("ready");
        if (mode === "hover" || reducedMotion()) {
          anim.goToAndStop(0, true);
          return;
        }
        // Играем только видимые стикеры — длинная переписка не грузит процессор.
        observer = new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting) anim.play();
          else anim.pause();
        });
        observer.observe(box);
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      animRef.current?.destroy();
      animRef.current = null;
    };
  }, [url, mode]);

  const hoverProps =
    mode === "hover"
      ? {
          onMouseEnter: () => !reducedMotion() && animRef.current?.play(),
          onMouseLeave: () => animRef.current?.goToAndStop(0, true),
        }
      : {};

  return (
    <div className={s.sticker} style={{ width: size, height: size }} {...hoverProps} role="img" aria-label={emoji ? `Стикер ${emoji}` : "Стикер"}>
      <div ref={boxRef} className={s.canvas} />
      {state !== "ready" && (
        <span className={s.placeholder} style={{ fontSize: size * 0.55 }} aria-hidden>
          {emoji || "🙂"}
        </span>
      )}
    </div>
  );
}
