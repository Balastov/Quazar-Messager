import { useLayoutEffect, useRef, type ReactNode } from "react";
import s from "./SwipeBack.module.css";

const INTERACTIVE = "input,textarea,select,button,a,img,video,audio,canvas,iframe,pre,summary,[contenteditable],[role='button'],[role='slider'],[role='dialog'],[data-swipe-back-ignore]";
function scrollsHorizontally(target: Element, root: HTMLElement): boolean {
  let node: Element | null = target;
  while (node && node !== root) {
    if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
    node = node.parentElement;
  }
  return false;
}

/** Mobile right swipe. Only prevent a touch after horizontal intent is established. */
export default function SwipeBack({ onBack, screenId, className = "", children }: {
  onBack(): void; screenId?: string | null; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null), back = useRef(onBack); back.current = onBack;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let start: { x: number; y: number; time: number; id: number; horizontal: boolean; dx: number } | null = null;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { clearTimeout(resetTimer); root.style.removeProperty("transform"); root.style.removeProperty("transition"); delete root.dataset.swiping; };
    const reset = (animate = false) => {
      start = null;
      if (animate && root.style.transform && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        delete root.dataset.swiping; root.style.transition = "transform 160ms ease-out"; root.style.transform = "translate3d(0,0,0)";
        clearTimeout(resetTimer); resetTimer = setTimeout(clean, 170);
      } else clean();
    };
    const touchStart = (event: TouchEvent) => {
      reset();
      if (!window.matchMedia?.("(max-width: 767px)").matches || event.touches.length !== 1 || document.fullscreenElement) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(INTERACTIVE) || scrollsHorizontally(target, root) || window.getSelection()?.toString()) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, time: Date.now(), id: touch.identifier, horizontal: false, dx: 0 };
    };
    const touchMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || Date.now() - start.time > 700 || window.getSelection()?.toString()) { reset(true); return; }
      const touch = Array.from(event.touches).find(item => item.identifier === start!.id);
      if (!touch) { reset(true); return; }
      const dx = touch.clientX - start.x, dy = Math.abs(touch.clientY - start.y);
      if (!start.horizontal) {
        if (dx < -12 || (dy > 12 && dy >= Math.abs(dx))) { reset(); return; }
        if (dx < 14 || dx < dy * 1.5) return;
        start.horizontal = true;
      }
      start.dx = Math.max(0, dx);
      if (event.cancelable) event.preventDefault();
      if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        root.dataset.swiping = "true";
        root.style.transform = `translate3d(${Math.min(start.dx, window.innerWidth * .5)}px,0,0)`;
      }
    };
    const touchEnd = (event: TouchEvent) => {
      if (!start) return;
      const gesture = start;
      const touch = Array.from(event.changedTouches).find(item => item.identifier === gesture.id);
      if (gesture.horizontal && event.cancelable) event.preventDefault();
      const distance = touch ? touch.clientX - gesture.x : gesture.dx;
      const vertical = touch ? Math.abs(touch.clientY - gesture.y) : 0;
      const threshold = Math.min(120, Math.max(64, window.innerWidth * .22));
      const complete = gesture.horizontal && distance >= threshold && distance > vertical * 1.5 && Date.now() - gesture.time <= 700;
      reset(!complete);
      if (complete) back.current();
    };
    const cancel = () => reset();
    root.addEventListener("touchstart", touchStart, { passive: true });
    root.addEventListener("touchmove", touchMove, { passive: false });
    root.addEventListener("touchend", touchEnd, { passive: false });
    root.addEventListener("touchcancel", cancel, { passive: true });
    window.addEventListener("resize", cancel);
    return () => {
      reset(); window.removeEventListener("resize", cancel);
      root.removeEventListener("touchstart", touchStart); root.removeEventListener("touchmove", touchMove);
      root.removeEventListener("touchend", touchEnd); root.removeEventListener("touchcancel", cancel);
    };
  }, [screenId]);
  return <div ref={ref} data-swipe-back="" className={`${s.surface} ${className}`}>{children}</div>;
}
