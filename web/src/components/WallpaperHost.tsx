import { useEffect, useState, useSyncExternalStore } from "react";
import { loadImageUrl } from "../attachments/cache";
import { useChatStore } from "../store/chat";
import { useStarsStore } from "../store/stars";
import { useUiStore } from "../store/ui";
import { useWallpaperStore } from "../store/wallpaper";
import { pickWallpaper, wallpaperCss } from "../utils/wallpaper";

const MOBILE = "(max-width: 767px)";

function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(MOBILE);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(MOBILE).matches
  );
}

/** Ставит обои приложения под то, что сейчас на экране. Ничего не рисует. */
export default function WallpaperHost() {
  const tab = useUiStore((st) => st.tab);
  const mobileChatOpen = useUiStore((st) => st.mobileChatOpen);
  const activeChatId = useChatStore((st) => st.activeChatId);
  const chatBackground = useChatStore((st) => (activeChatId ? st.backgrounds[activeChatId] : undefined));
  const activeStarId = useStarsStore((st) => st.activeStarId);
  const starUrl = useStarsStore(
    (st) => st.stars.find((s) => s.id === st.activeStarId)?.background_url ?? null
  );
  const personalUrl = useWallpaperStore((st) => st.personalUrl);
  const isMobile = useIsMobile();
  const [chatUrl, setChatUrl] = useState<string | null>(null);

  // Фон чата зашифрован так же, как фото в нём: скачать, расшифровать, показать как blob:.
  useEffect(() => {
    setChatUrl(null);
    if (!activeChatId || !chatBackground) return;
    let alive = true;
    loadImageUrl(activeChatId, chatBackground)
      .then((url) => alive && setChatUrl(url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeChatId, chatBackground]);

  const url = pickWallpaper({
    chatVisible:
      (tab === "chats" || tab === "contacts") && !!activeChatId && (!isMobile || mobileChatOpen),
    chatUrl,
    starVisible: tab === "stars" && !!activeStarId,
    starUrl,
    personalUrl,
  });

  useEffect(() => {
    const root = document.documentElement;
    if (!url) {
      root.style.removeProperty("--qz-wallpaper");
      return;
    }
    // Меняем, когда картинка уже загрузилась, — без вспышки пустого фона.
    let alive = true;
    const img = new Image();
    img.onload = () => alive && root.style.setProperty("--qz-wallpaper", wallpaperCss(url));
    img.onerror = () => alive && root.style.removeProperty("--qz-wallpaper");
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);

  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--qz-wallpaper");
    },
    []
  );

  return null;
}
