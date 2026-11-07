import { useEffect, useId, useRef, useState } from "react";
import axios from "axios";
import { http } from "../api/client";
import { useAuthStore } from "../store/auth";
import { useCallStore } from "../store/call";
import { useVoiceStore } from "../store/voice";
import { desktop } from "../platform/desktop";
import { getCtx, startCallRingtone } from "../notifications/sound";
import { CHECK_ERRORS, notificationHelp, prepareNotificationCheck, type ConnectionCheck } from "../notifications/connectionCheck";
import { dropPushSubscription, ensurePushSubscription } from "../notifications/push";
import { socket } from "../ws/socket";
import MicCheck from "./MicCheck";
import settings from "./SettingsView.module.css";
import s from "./ConnectionDiagnostics.module.css";

export default function ConnectionDiagnostics() {
  const [open, setOpen] = useState(false), id = useId();
  return <div className={s.root}>
    <button type="button" className={settings.secondary} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {open ? "Закрыть проверку связи" : "Проверить связь"}
    </button>
    {open && <div id={id}><Checks /></div>}
  </div>;
}
function errorText(error: unknown) {
  if (axios.isAxiosError(error)) {
    if (typeof error.response?.data?.detail === "string") return error.response.data.detail;
    return "Сервер не ответил на проверку. Проверьте подключение к интернету и попробуйте ещё раз.";
  }
  return error instanceof Error ? error.message : "Не удалось выполнить проверку. Проверьте подключение к интернету.";
}
function Checks() {
  const userId = useAuthStore(state => state.user?.id);
  const callPhase = useCallStore(state => state.phase), voice = useVoiceStore(state => state.status);
  const busy = !["idle", "ended"].includes(callPhase) || voice !== "idle";
  const [checking, setChecking] = useState(false), [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [notice, setNotice] = useState(""), [problem, setProblem] = useState("");
  const [confirmation, setConfirmation] = useState<"yes" | "no" | null>(null);
  const [sound, setSound] = useState<"idle" | "playing" | "heard" | "silent" | "waiting">("idle");
  const id = useRef<string | null>(null), round = useRef(0), mounted = useRef(false);
  const abort = useRef<AbortController | null>(null), poll = useRef<ReturnType<typeof setTimeout>>();
  const stopSound = useRef<(() => void) | null>(null), soundTimer = useRef<ReturnType<typeof setTimeout>>();
  const silence = () => { clearTimeout(soundTimer.current); stopSound.current?.(); stopSound.current = null; };
  useEffect(() => {
    mounted.current = true;
    id.current = null; setCheck(null); setNotice(""); setProblem(""); setConfirmation(null); setChecking(false);
    return () => { mounted.current = false; round.current++; abort.current?.abort(); clearTimeout(poll.current); silence(); };
  }, [userId]);
  useEffect(() => {
    if (!desktop()) return;
    const off = socket.on(event => {
      if (event.type !== "connection_test" || event.test_id !== id.current || event.recipient_user_id !== userId || useAuthStore.getState().user?.id !== userId) return;
      void (async () => {
        try {
          const shown = await desktop()!.showNotification({ title: event.title, body: event.body, tag: `quazar-test-${event.test_id}`, silent: false, data: { kind: "diagnostic" } });
          if (shown && mounted.current && useAuthStore.getState().user?.id === userId) await http.post(`/push/diagnostics/${event.test_id}/receipt`, { secret: event.receipt_secret }, { timeout: 8000 });
        } catch { /* Polling and the user's confirmation explain delivery failures. */ }
      })();
    });
    return () => { off(); };
  }, [userId]);
  useEffect(() => { if (busy) { silence(); setSound("idle"); } }, [busy]);
  const testNotification = async () => {
    const current = ++round.current; abort.current?.abort(); clearTimeout(poll.current);
    const controller = new AbortController(); abort.current = controller;
    setChecking(true); setCheck(null); setProblem(""); setConfirmation(null); setNotice("Подготавливаем доставку на это устройство…");
    id.current = null;
    try {
      const target = await prepareNotificationCheck();
      if (!mounted.current || current !== round.current || useAuthStore.getState().user?.id !== userId) return;
      const testId = crypto.randomUUID(); id.current = testId;
      const { data } = await http.post<ConnectionCheck>("/push/diagnostics", { id: testId, ...target }, { signal: controller.signal, timeout: 12000 });
      if (!mounted.current || current !== round.current) return;
      setCheck(data); setNotice("Через несколько секунд придёт уведомление. Можно свернуть Quazar и проверить доставку в фоне.");
      const started = Date.now();
      const refresh = async () => {
        if (!mounted.current || current !== round.current) return;
        try {
          const { data } = await http.get<ConnectionCheck>(`/push/diagnostics/${testId}`, { signal: controller.signal, timeout: 8000 });
          if (!mounted.current || current !== round.current) return;
          setCheck(data);
          if (data.state === "displayed") { setNotice("Устройство подтвердило передачу уведомления системе. Вы увидели его?"); setChecking(false); return; }
          if (data.state === "failed" || data.state === "expired") {
            setProblem(CHECK_ERRORS[data.error_code ?? ""] ?? "Подтверждение доставки не получено. " + notificationHelp()); setChecking(false); return;
          }
          if (Date.now() - started > 25_000) { setNotice("Подтверждение показа ещё не получено. Если уведомление появилось, подтвердите это ниже. " + notificationHelp()); setChecking(false); return; }
          poll.current = setTimeout(() => void refresh(), 1000);
        } catch (error) {
          if (!mounted.current || current !== round.current || controller.signal.aborted) return;
          setProblem(errorText(error)); setChecking(false);
        }
      };
      poll.current = setTimeout(() => void refresh(), 1000);
    } catch (error) {
      if (!mounted.current || current !== round.current || controller.signal.aborted) return;
      setProblem(errorText(error)); setNotice(""); setChecking(false);
    }
  };
  const ringtone = () => {
    silence();
    const context = getCtx();
    if (!context) { setSound("silent"); return; }
    void context.resume().catch(() => {});
    stopSound.current = startCallRingtone(); setSound("playing");
    soundTimer.current = setTimeout(() => { silence(); if (mounted.current) setSound("waiting"); }, 3500);
  };
  return <div className={s.panel}>
    <p className={settings.hint}>Проверка касается только этого устройства. Микрофон и звук запускаются отдельными кнопками; настоящий звонок никому не совершается.</p>
    <section className={s.test} aria-label="Проверка уведомлений">
      <h4>1. Уведомление с сервера</h4>
      <div className={s.actions}>
        <button type="button" className={settings.secondary} disabled={checking} onClick={() => void testNotification()}>{checking ? "Проверяем доставку…" : "Отправить тестовое уведомление"}</button>
        {!desktop() && problem && <button type="button" className={settings.secondary} disabled={checking} onClick={() => {
          setChecking(true); setProblem("");
          void dropPushSubscription().then(() => useAuthStore.getState().user?.id === userId ? ensurePushSubscription() : false).then(ok => {
            if (mounted.current && useAuthStore.getState().user?.id === userId) { setNotice(ok ? "Уведомления переподключены. Повторите проверку доставки." : "Не удалось переподключить уведомления. " + notificationHelp()); setChecking(false); }
          });
        }}>Переподключить уведомления</button>}
      </div>
      {notice && <p className={s.status} role="status">{notice}</p>}
      {problem && <p className={`${s.status} ${s.warn}`} role="alert">{problem}</p>}
      {check && <div className={s.actions}>
        <button type="button" className={settings.secondary} onClick={() => setConfirmation("yes")}>Уведомление пришло</button>
        <button type="button" className={settings.secondary} onClick={() => setConfirmation("no")}>Не вижу уведомления</button>
      </div>}
      {confirmation && <p className={`${s.status} ${confirmation === "yes" ? s.ok : s.warn}`} role="status">{confirmation === "yes" ? "Вы подтвердили получение: доставка на этом устройстве работает." : notificationHelp()}</p>}
    </section>
    <section className={s.test} aria-label="Проверка микрофона">
      <h4>2. Микрофон</h4>
      {busy && <p className={settings.hint}>Завершите текущий звонок или выйдите из голосовой комнаты, чтобы проверить микрофон.</p>}
      <MicCheck buttonClass={settings.secondary} hintClass={settings.hint} disabled={busy} />
    </section>
    <section className={s.test} aria-label="Проверка звука звонка">
      <h4>3. Звук входящего звонка</h4>
      <div className={s.actions}>
        <button type="button" className={settings.secondary} disabled={busy} onClick={ringtone}>{sound === "playing" ? "Повторить звук" : "Послушать звонок"}</button>
        {sound !== "idle" && <>
          <button type="button" className={settings.secondary} onClick={() => { silence(); setSound("heard"); }}>Слышу звук</button>
          <button type="button" className={settings.secondary} onClick={() => { silence(); setSound("silent"); }}>Не слышу</button>
        </>}
      </div>
      {sound === "playing" && <p className={s.status} role="status">Сейчас звучит обычный сигнал входящего звонка.</p>}
      {sound === "waiting" && <p className={s.status} role="status">Вы услышали сигнал?</p>}
      {sound === "heard" && <p className={`${s.status} ${s.ok}`} role="status">Вы подтвердили: звук звонка слышен.</p>}
      {sound === "silent" && <p className={`${s.status} ${s.warn}`} role="status">Проверьте громкость устройства и вкладки, выбранный динамик и подключённые наушники. В настройках системы звук может быть направлен на другое устройство.</p>}
    </section>
  </div>;
}
