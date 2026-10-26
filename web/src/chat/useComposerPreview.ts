import { useEffect, useState } from "react";
import { fetchPreview, firstLink, previewsEnabled, type LinkPreview } from "./linkPreview";

/**
 * Превью первой ссылки в поле ввода: собирается, пока человек пишет (с паузой), и уходит
 * вместе с сообщением. Крестик убирает превью для этой ссылки.
 */
export function useComposerPreview(text: string, enabled = true) {
  const url = enabled && previewsEnabled() ? firstLink(text) : null;
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    if (!url || url === dismissed) return;
    let alive = true;
    const timer = setTimeout(() => {
      void fetchPreview(url).then((p) => alive && setPreview(p));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, dismissed]);

  const current = preview && preview.url === url && url !== dismissed ? preview : null;
  return {
    preview: current,
    dismiss: () => setDismissed(url),
    /** После отправки — забыть крестик, следующая ссылка снова с превью. */
    reset: () => setDismissed(null),
  };
}
