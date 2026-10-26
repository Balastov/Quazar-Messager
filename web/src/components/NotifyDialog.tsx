import { useState } from "react";
import ChatDialog from "./chat/ChatDialog";
import {
  LEVEL_LABEL,
  MUTE_OPTIONS,
  levelSummary,
  mutedNow,
  settingKey,
  useNotifyStore,
  type NotifyLevel,
  type NotifyScope,
} from "../notifications/levels";
import c from "./constellation/Constellation.module.css";
import s from "./chat/Chat.module.css";

interface Props {
  scope: NotifyScope;
  targetId: string;
  title: string;
  /** Что будет без своей настройки: для Спутника — «как в Звезде (…)», для остального — по умолчанию. */
  inherited: NotifyLevel;
  /** Есть ли смысл в «только упоминания» (в личном чате — нет). */
  mentions?: boolean;
  /** Подпись для «как уровнем выше»; нет — пункта нет (у чатов и Звёзд — это сам уровень по умолчанию). */
  inheritLabel?: string;
  onClose: () => void;
}

/** Уровень уведомлений и «выключить на время» для чата, Звезды или Спутника. */
export default function NotifyDialog({ scope, targetId, title, inherited, mentions = true, inheritLabel, onClose }: Props) {
  const setting = useNotifyStore((st) => st.settings[settingKey(scope, targetId)]);
  const save = useNotifyStore((st) => st.save);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = setting?.level ?? null;
  const muted = mutedNow(setting);

  const apply = async (body: { level: NotifyLevel | null; muted_until: string | null }, close = true) => {
    setBusy(true);
    setError(null);
    try {
      await save(scope, targetId, body);
      if (close) onClose();
    } catch {
      setError("Не удалось сохранить — попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  };

  const levels: NotifyLevel[] = mentions ? ["all", "mentions", "none"] : ["all", "none"];
  const current = own ?? (inheritLabel ? null : inherited);

  return (
    <ChatDialog title={title} onClose={onClose}>
      <p className={c.hint}>
        Сейчас: {levelSummary(own ?? inherited, setting)}. Непрочитанное считается всегда — уровень решает, будут ли
        всплывашка, звук и push.
      </p>
      <div className={s.options}>
        {inheritLabel && (
          <button
            type="button"
            className={current === null ? s.optionActive : s.option}
            disabled={busy}
            onClick={() => void apply({ level: null, muted_until: setting?.muted_until ?? null })}
          >
            {inheritLabel}
            {current === null && <span className={s.optionHint}>сейчас</span>}
          </button>
        )}
        {levels.map((level) => (
          <button
            key={level}
            type="button"
            className={current === level ? s.optionActive : s.option}
            disabled={busy}
            onClick={() => void apply({ level, muted_until: setting?.muted_until ?? null })}
          >
            {level === "none" ? "🔕 " : level === "mentions" ? "@ " : "🔔 "}
            {LEVEL_LABEL[level]}
            {current === level && <span className={s.optionHint}>сейчас</span>}
          </button>
        ))}
      </div>
      <p className={c.hint} style={{ marginTop: 4 }}>
        {muted ? "Выключены на время:" : "Выключить на время:"}
      </p>
      <div className={c.row}>
        {muted ? (
          <button
            type="button"
            className={`${c.secondary} ${c.small}`}
            disabled={busy}
            onClick={() => void apply({ level: own, muted_until: null })}
          >
            🔔 Включить сейчас
          </button>
        ) : (
          MUTE_OPTIONS.map((o) => (
            <button
              key={o.minutes}
              type="button"
              className={`${c.secondary} ${c.small}`}
              disabled={busy}
              onClick={() =>
                void apply({ level: own, muted_until: new Date(Date.now() + o.minutes * 60_000).toISOString() })
              }
            >
              {o.label}
            </button>
          ))
        )}
      </div>
      {error && <div className={c.error}>{error}</div>}
    </ChatDialog>
  );
}
