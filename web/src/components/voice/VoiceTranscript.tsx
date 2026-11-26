import { useEffect, useRef, useState } from "react";
import { isAxiosError } from "axios";
import { cachedVoiceTranscript, transcriptionEnabled, transcribeVoice } from "../../attachments/transcription";
import type { VoiceRef } from "../../attachments/voice";
import { useAuthStore } from "../../store/auth";
import s from "./Voice.module.css";

export default function VoiceTranscript({ chatId, voice }: { chatId: string; voice: VoiceRef }) {
  const userId = useAuthStore((state) => state.user?.id);
  const [enabled, setEnabled] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    const current = ++revision.current;
    setEnabled(false); setConsent(false); setBusy(false); setText(null); setError(null);
    if (userId) void transcriptionEnabled(userId).then((value) => {
      if (current === revision.current) setEnabled(value);
    });
    if (userId) {
      const cached = cachedVoiceTranscript(userId, chatId, voice.id);
      if (cached) {
        setBusy(true);
        void cached.then((value) => {
          if (current === revision.current) setText(value);
        }).catch(() => {}).finally(() => {
          if (current === revision.current) setBusy(false);
        });
      }
    }
    return () => { revision.current++; };
  }, [userId, chatId, voice.id]);

  const start = async () => {
    if (!userId || busy) return;
    const current = revision.current;
    setBusy(true); setConsent(false); setError(null);
    try {
      const result = await transcribeVoice(userId, chatId, voice);
      if (current === revision.current) setText(result);
    } catch (err) {
      if (current === revision.current) {
        const detail = isAxiosError(err) && err.response?.data?.detail;
        setError(typeof detail === "string" ? detail : "Не удалось расшифровать. Попробуйте ещё раз");
      }
    } finally {
      if (current === revision.current) setBusy(false);
    }
  };

  if (!enabled) return null;
  return <div className={s.transcript} onClick={(event) => event.stopPropagation()}>
    {text !== null ? <>
      <div className={s.transcriptLabel}>Расшифровка · может содержать ошибки</div>
      <div className={s.transcriptText}>{text || "Речь не обнаружена"}</div>
    </> : consent ? <>
      <p className={s.consentText}>Эта запись будет отправлена через сервер Quazar в Cloudflare для распознавания речи. Текст останется в памяти этой вкладки.</p>
      <div className={s.transcriptActions}>
        <button type="button" className={s.transcribeButton} onClick={() => void start()}>Отправить и расшифровать</button>
        <button type="button" className={s.transcribeButton} onClick={() => setConsent(false)}>Отмена</button>
      </div>
    </> : <button type="button" className={s.transcribeButton} disabled={busy} onClick={() => setConsent(true)}>
      {busy ? "Расшифровываем…" : error ? "Повторить расшифровку" : "Расшифровать"}
    </button>}
    {error && <div className={s.transcriptError} role="alert">{error}</div>}
  </div>;
}
