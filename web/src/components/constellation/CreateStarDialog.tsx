import { useState } from "react";
import type { StarKind } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import s from "./Constellation.module.css";

interface Props {
  onClose: () => void;
}

const KINDS: { kind: StarKind; title: string; text: string }[] = [
  {
    kind: "gaming",
    title: "🎮 Игры",
    text: "Как в Дискорде: до 3 Спутников (текстовых каналов) и до 5 Планет (голосовых).",
  },
  {
    kind: "work",
    title: "💼 Работа",
    text: "Сколько угодно каналов. Голосовые Комнаты на карте офиса: коворкинг, переговорные, кухня.",
  },
];

export default function CreateStarDialog({ onClose }: Props) {
  const limits = useStarsStore((st) => st.limits);
  const createStar = useStarsStore((st) => st.createStar);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StarKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limitReached = !!limits && limits.owned_stars >= limits.max_owned_stars;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kind || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createStar(name.trim(), kind);
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Новая Звезда" onClose={onClose}>
      {limitReached ? (
        <>
          <p className={s.hint}>
            Вы уже создали {limits.max_owned_stars} Звезды — это максимум. Чтобы создать новую,
            удалите одну из своих или передайте её другому участнику (Настройки Звезды →
            «Звезда»).
          </p>
          <button type="button" className={s.secondary} onClick={onClose}>
            Понятно
          </button>
        </>
      ) : (
        <form className={s.list} onSubmit={(e) => void submit(e)}>
          <label className={s.label}>
            Название
            <input
              className={s.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="Например, «Отдел продаж» или «Вечерний рейд»"
              autoFocus
              disabled={busy}
            />
          </label>

          <div className={s.kinds}>
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                className={kind === k.kind ? s.kindActive : s.kind}
                onClick={() => setKind(k.kind)}
                aria-pressed={kind === k.kind}
                disabled={busy}
              >
                <span className={s.kindTitle}>{k.title}</span>
                <span className={s.kindText}>{k.text}</span>
              </button>
            ))}
          </div>

          <p className={`${s.hint} ${s.warn}`}>Тип Звезды потом не сменить.</p>
          {limits && (
            <p className={s.hint}>
              Создано {limits.owned_stars} из {limits.max_owned_stars}. В одной Звезде — до{" "}
              {limits.max_star_members} участников.
            </p>
          )}
          {error && <div className={s.error}>{error}</div>}

          <button
            type="submit"
            className={s.primary}
            disabled={busy || !kind || !name.trim()}
          >
            {busy ? "Создаём…" : "Создать Звезду"}
          </button>
        </form>
      )}
    </Dialog>
  );
}
