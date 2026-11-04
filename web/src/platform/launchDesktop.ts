export const DESKTOP_LAUNCH_URL = "quazar-desktop://app/update";
export const DESKTOP_LAUNCH_WAIT = 4000;
export const navigateDesktop = (url: string) => window.location.assign(url);

/** Browsers cannot enumerate installed apps. Losing focus cancels the automatic fallback. */
export function tryLaunchDesktop(onFallback: () => void, onExternal: () => void, navigate = navigateDesktop): () => void {
  let finished = false;
  const cleanup = () => {
    clearTimeout(timer); window.removeEventListener("blur", external);
    document.removeEventListener("visibilitychange", visibility);
  };
  const external = () => { if (!finished) { finished = true; cleanup(); onExternal(); } };
  const visibility = () => { if (document.visibilityState === "hidden") external(); };
  const fallback = () => {
    if (finished) return;
    if (document.visibilityState === "hidden" || !document.hasFocus()) { external(); return; }
    finished = true; cleanup(); onFallback();
  };
  const timer = setTimeout(fallback, DESKTOP_LAUNCH_WAIT);
  window.addEventListener("blur", external); document.addEventListener("visibilitychange", visibility);
  try { navigate(DESKTOP_LAUNCH_URL); } catch { fallback(); }
  return () => { finished = true; cleanup(); };
}
