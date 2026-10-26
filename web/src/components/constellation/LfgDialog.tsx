import { useState } from "react";
import { starsApi } from "../../api/stars";
import { toLocalInput } from "../../chat/when";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";

/** Сбор группы: «Ищу пати: Dota, 5 мест, 21:00». */
export default function LfgDialog({ starId, channelId, onClose }: { starId: string; channelId: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [slots, setSlots] = useState(5);
  const [timed, setTimed] = useState(false);
  const [startsAt, setStartsAt] = useState(() => {
    const d = new Date(Date.now() + 3600_000);
    d.setMinutes(0, 0, 0);
    return toLocalInput(d);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await starsApi.createLfg(starId, channelId, {
        title: title.trim(),
        slots,
        starts_at: timed ? new Date(startsAt).toISOString() : null,
      });
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось начать сбор"));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Сбор группы" onClose={onClose}>
      <form className={g.form} onSubmit={(e) => void submit(e)}>
        <p className={s.hint}>
          Участники записываются в сообщении. Когда сбор начнётся — по времени или по вашей кнопке, —
          появится временная Планета, и всех записавшихся позовут на неё.
        </p>
        <label className={s.label}>
          Во что и зачем
          <input className={s.input} value={title} maxLength={100} autoFocus placeholder="Dota 2, рейтинг" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className={s.label}>
          Мест, включая вас: {slots}
          <input type="range" min={2} max={25} value={slots} onChange={(e) => setSlots(Number(e.target.value))} />
        </label>
        <label className={g.check}>
          <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
          Начать в назначенное время
        </label>
        {timed && (
          <input type="datetime-local" className={s.input} style={{ colorScheme: "dark" }} value={startsAt} min={toLocalInput(new Date())} onChange={(e) => setStartsAt(e.target.value)} />
        )}
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={!title.trim() || busy}>
          Объявить сбор
        </button>
      </form>
    </Dialog>
  );
}
