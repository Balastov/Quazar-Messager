import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isNewerVersion } from "../platform/appVersion";
import { useDesktopRelease } from "../platform/useDesktopRelease";
import { navigateDesktop, tryLaunchDesktop } from "../platform/launchDesktop";
import type { DesktopReleaseOS, PublishedDesktopRelease } from "../platform/desktopReleases";
import Dialog from "./constellation/Dialog";
import s from "./AppVersion.module.css";

type Launch = { release: PublishedDesktopRelease; phase: "opening" | "fallback" | "external" };

export default function WebDesktopDownload({ os, currentVersion }: { os?: DesktopReleaseOS; currentVersion: string }) {
  const release = useDesktopRelease(os);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const stop = useRef<(() => void)>();
  useEffect(() => () => stop.current?.(), []);
  const close = () => { stop.current?.(); setLaunch(null); };
  const start = () => {
    if (!release) return;
    stop.current?.(); setLaunch({ release, phase: "opening" });
    stop.current = tryLaunchDesktop(() => {
      setLaunch({ release, phase: "fallback" });
      if (os === "windows") {
        try { navigateDesktop(release.installers[0].url); } catch { /* The direct link remains available. */ }
      }
    }, () => setLaunch({ release, phase: "external" }));
  };
  return <>
    {release && isNewerVersion(release.version, currentVersion) && <button type="button" className={s.update}
      title={`Открыть Quazar или скачать десктопную версию ${release.version}`} onClick={start}>Скачать</button>}
    {launch && createPortal(<Dialog title={`Quazar ${launch.release.version} для компьютера`} onClose={close}>
      <div className={s.downloads}>
        <p role="status">{launch.phase === "opening" ? "Пытаемся открыть установленный Quazar… Разрешите запуск приложения, если браузер спросит."
          : launch.phase === "external" ? "Если Quazar открылся, он проверит обновления. Если окно не появилось, скачайте установщик ниже."
            : os === "windows" ? "Если приложение не открылось, скачивается последняя сборка. Если скачивание не началось, воспользуйтесь ссылкой ниже."
              : "Если приложение не открылось, выберите установщик для своего Mac. Процессор указан в меню Apple → «Об этом Mac»."}</p>
        {launch.release.installers.map(installer => <a key={installer.url} className={s.installer} href={installer.url} onClick={() => stop.current?.()}>
          Скачать · {installer.name}
        </a>)}
        <p>Установка поверх текущего приложения сохраняет ваши данные.</p>
      </div>
    </Dialog>, document.body)}
  </>;
}
