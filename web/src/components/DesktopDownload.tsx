import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MonitorDown, Smartphone, X } from "lucide-react";
import { desktop } from "../platform/desktop";
import { DESKTOP_INSTALLERS, DOWNLOAD_OFFER_DELAY, DOWNLOAD_PROMPT_KEY, detectDownloadOS,
  downloadPreference, parseDownloadPreference, type DownloadAnswer, type DownloadOS, type DownloadPreference } from "../platform/desktopDownloads";
import { useAuthStore } from "../store/auth";
import { useCallStore } from "../store/call";
import { useVoiceStore } from "../store/voice";
import Dialog from "./constellation/Dialog";
import { DesktopDownloadContext } from "./DesktopDownloadContext";
import s from "./DesktopDownload.module.css";

type Mode = { kind: "offer" | "choose"; automatic: boolean } | null;

export function DesktopDownloads({ children }: { children: ReactNode }) {
  const token = useAuthStore(st => st.token);
  const call = useCallStore(st => st.phase);
  const voice = useVoiceStore(st => st.status);
  const insideDesktop = !!desktop();
  const [os] = useState(() => detectDownloadOS(navigator));
  const [mode, setMode] = useState<Mode>(null);
  const [never, setNever] = useState(false);
  const fallback = useRef<DownloadPreference | null>(null);
  const busy = (call !== "idle" && call !== "ended") || voice !== "idle";
  const read = useCallback(() => {
    try { return parseDownloadPreference(localStorage.getItem(DOWNLOAD_PROMPT_KEY)) ?? fallback.current; }
    catch { return fallback.current; }
  }, []);
  const answer = useCallback((value: DownloadAnswer) => {
    const preference = downloadPreference(value, never);
    fallback.current = preference;
    try { localStorage.setItem(DOWNLOAD_PROMPT_KEY, JSON.stringify(preference)); } catch { /* Запоминаем до закрытия страницы. */ }
    setMode(null); setNever(false);
  }, [never]);

  useEffect(() => {
    if (insideDesktop || (os !== "windows" && os !== "mac") || !token || busy || mode) return;
    const readyAt = Date.now() + DOWNLOAD_OFFER_DELAY;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => { clearTimeout(timer); timer = setTimeout(check, delay); };
    const check = () => {
      const preference = read();
      if (preference?.never) return;
      if (preference && preference.nextAt > Date.now()) { schedule(Math.min(preference.nextAt - Date.now(), 30 * 60_000)); return; }
      const typing = document.activeElement?.closest("input, textarea, select, [contenteditable='true']");
      if (Date.now() < readyAt || document.visibilityState !== "visible" || !document.hasFocus() || typing ||
          /^\/(auth|guest)(\/|$)/.test(window.location.pathname) || document.querySelector('[role="dialog"], [aria-modal="true"], [data-notify-prompt]')) {
        schedule(Math.max(15_000, readyAt - Date.now())); return;
      }
      setNever(false); setMode({ kind: "offer", automatic: true });
    };
    const refresh = () => schedule(Math.max(1000, readyAt - Date.now()));
    schedule(DOWNLOAD_OFFER_DELAY);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(timer); window.removeEventListener("focus", refresh); window.removeEventListener("storage", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [insideDesktop, os, token, busy, mode, read]);

  useEffect(() => {
    if (mode?.automatic && (busy || !token)) { setMode(null); setNever(false); }
  }, [busy, token, mode]);

  const open = () => { setNever(read()?.never ?? false); setMode({ kind: "choose", automatic: false }); };
  const titleId = useId();
  const context = insideDesktop ? null : { os, open, downloaded: () => answer("yes") };
  return <DesktopDownloadContext.Provider value={context}>{children}
    {!insideDesktop && mode?.kind === "offer" && createPortal(
      <aside className={s.offer} role="dialog" aria-labelledby={titleId}>
        <button type="button" className={s.close} aria-label="Напомнить о десктопной версии позже" onClick={() => answer("later")}><X size={16} /></button>
        <MonitorDown size={26} className={s.symbol} aria-hidden />
        <h2 id={titleId}>Скачать десктоп версию?</h2>
        <p>Quazar в отдельном окне на вашем компьютере. {os === "windows" ? "Тестовая версия для Windows." : "Тестовая версия для macOS."}</p>
        <div className={s.actions}>
          {os === "windows" ? <a className={s.primary} href={DESKTOP_INSTALLERS.windows.url} target="_blank" rel="noopener noreferrer" onClick={() => answer("yes")}>Да</a>
            : <button type="button" className={s.primary} onClick={() => setMode({ kind: "choose", automatic: true })}>Да</button>}
          <button type="button" className={s.secondary} onClick={() => answer("later")}>Позже</button>
          <button type="button" className={s.quiet} onClick={() => answer("no")}>Не хочу</button>
        </div>
        <label className={s.checkbox}><input type="checkbox" checked={never} onChange={event => setNever(event.target.checked)} />Больше не спрашивать</label>
        <p className={s.cooldown}>«Позже» — через неделю, «Не хочу» — через месяц.</p>
      </aside>, document.body)}
    {!insideDesktop && mode?.kind === "choose" && createPortal(
      os === "mobile" ? <MobileDownloadNotice onClose={() => setMode(null)} />
        : <DownloadChoices os={os} never={never} onNever={setNever} onDownload={() => answer("yes")} onClose={() => answer("later")} />,
      document.body)}
  </DesktopDownloadContext.Provider>;
}

function MobileDownloadNotice({ onClose }: { onClose(): void }) {
  return <Dialog title="Мобильное приложение" onClose={onClose}>
    <div className={s.mobileNotice}>
      <Smartphone size={36} className={s.symbol} aria-hidden />
      <p>Мобильное приложение почти готово, ожидайте уведомление</p>
      <button type="button" className={s.primary} autoFocus onClick={onClose}>Понятно</button>
    </div>
  </Dialog>;
}

function DownloadChoices({ os, never, onNever, onDownload, onClose }: {
  os: DownloadOS; never: boolean; onNever(value: boolean): void; onDownload(): void; onClose(): void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]');
    content.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const targets = [...dialog.querySelectorAll<HTMLElement>('button, a[href], input')].filter(el => !el.hasAttribute("disabled"));
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", trap);
    return () => { dialog?.removeEventListener("keydown", trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const installers = os === "mac" ? [DESKTOP_INSTALLERS.macArm, DESKTOP_INSTALLERS.macIntel] : Object.values(DESKTOP_INSTALLERS);
  return <Dialog title="Скачать десктоп версию" onClose={onClose}>
    <div className={s.choices} ref={content}>
      <p>{os === "mac" ? "Выберите процессор вашего Mac. Его можно посмотреть в меню Apple → «Об этом Mac»."
        : "Сборки доступны для Windows и macOS. Выберите версию для своего компьютера."}</p>
      {installers.map(installer => <a key={installer.url} className={s.installer} href={installer.url} target="_blank" rel="noopener noreferrer" onClick={onDownload}>
        <MonitorDown size={20} aria-hidden /><span>{installer.name}</span><span aria-hidden>↓</span>
      </a>)}
      <p className={s.hint}>Скачивание без регистрации и входа в GitHub.</p>
      <label className={s.checkbox}><input type="checkbox" checked={never} onChange={event => onNever(event.target.checked)} />Больше не спрашивать</label>
    </div>
  </Dialog>;
}
