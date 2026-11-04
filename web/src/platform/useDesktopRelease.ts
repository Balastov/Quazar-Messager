import { useEffect, useState } from "react";
import { desktop } from "./desktop";
import { DESKTOP_RELEASE_POLL_INTERVAL, publishedDesktopRelease, type DesktopReleaseOS, type PublishedDesktopRelease } from "./desktopReleases";

export function useDesktopRelease(os?: DesktopReleaseOS) {
  const [release, setRelease] = useState<PublishedDesktopRelease | null>(null);
  useEffect(() => {
    setRelease(null);
    if (!os || desktop()) return;
    let active = true, checking = false;
    let controller: AbortController | undefined;
    const check = async () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const value = await publishedDesktopRelease(os, controller.signal);
        if (active && value) setRelease(value);
      } catch { /* A failed check must not advertise an unverified release. */ }
      finally { clearTimeout(timeout); checking = false; }
    };
    const refresh = () => { void check(); };
    refresh();
    const interval = setInterval(refresh, DESKTOP_RELEASE_POLL_INTERVAL);
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false; controller?.abort(); clearInterval(interval);
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [os]);
  return release;
}
