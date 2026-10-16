import { useState } from "react";
import type { ChannelKind, RoomKind, StarChannel, StarKind } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { apiError, ROOM_LABEL } from "./rules";
import s from "./Constellation.module.css";

const ROOM_KINDS = Object.keys(ROOM_LABEL) as RoomKind[];

interface Props {
  starKind: StarKind;
  kind: ChannelKind;
  /** Есть — редактируем, нет — создаём. */
  channel?: StarChannel;
  onClose: () => void;
}

export default function ChannelDialog({ starKind, kind, channel, onClose }: Props) {
  const limits = useStarsStore((st) => st.limits);
  const createChannel = useStarsStore((st) => st.createChannel);
  const updateChannel = useStarsStore((st) => st.updateChannel);
  const deleteChannel = useStarsStore((st) => st.deleteChannel);

  const isPlanet = kind === "planet";
  const isWork = starKind === "work";
  const maxCapacity = limits?.planet_max_capacity ?? 25;
  const defaultFor = (room: RoomKind | null) =>
    (room && limits?.room_kinds[room]) || 10;

  const [name, setName] = useState(channel?.name ?? "");
  const [roomKind, setRoomKind] = useState<RoomKind>(
    channel?.room_kind ?? (isWork ? "meeting" : "custom")
  );
  const [capacity, setCapacity] = useState<number>(
    channel?.capacity ?? defaultFor(isWork ? "meeting" : null)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = channel
    ? isPlanet
      ? "Изменить Планету"
      : "Изменить Спутник"
    : isPlanet
      ? "Новая Планета"
      : "Новый Спутник";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const planetFields = isPlanet
      ? { capacity, ...(isWork ? { room_kind: roomKind } : {}) }
      : {};
    void run(() =>
      channel
        ? updateChannel(channel.id, { name: trimmed, ...planetFields })
        : createChannel({ kind, name: trimmed, ...planetFields })
    );
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className={s.list} onSubmit={submit}>
        <label className={s.label}>
          Название
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
            placeholder={isPlanet ? (isWork ? "Например, «Переговорная 1»" : "Например, «Рейд»") : "Например, «новости»"}
            autoFocus
            disabled={busy}
          />
        </label>

        {isPlanet && isWork && (
          <label className={s.label}>
            Комната на карте офиса
            <select
              className={s.select}
              value={roomKind}
              onChange={(e) => {
                const next = e.target.value as RoomKind;
                setRoomKind(next);
                if (!channel) setCapacity(defaultFor(next));
              }}
              disabled={busy}
            >
              {ROOM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ROOM_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        )}

        {isPlanet && (
          <label className={s.label}>
            Сколько человек может зайти (до {maxCapacity})
            <input
              className={s.input}
              type="number"
              min={1}
              max={maxCapacity}
              value={capacity}
              onChange={(e) =>
                setCapacity(Math.max(1, Math.min(maxCapacity, Number(e.target.value) || 1)))
              }
              disabled={busy}
            />
          </label>
        )}

        {error && <div className={s.error}>{error}</div>}

        <button type="submit" className={s.primary} disabled={busy || !name.trim()}>
          {busy ? "Сохраняем…" : channel ? "Сохранить" : "Создать"}
        </button>

        {channel && (
          <button
            type="button"
            className={s.danger}
            disabled={busy}
            onClick={() => {
              const what = isPlanet ? "Планету" : "Спутник и всю его переписку";
              if (window.confirm(`Удалить ${what} «${channel.name}»? Это нельзя отменить.`)) {
                void run(() => deleteChannel(channel.id));
              }
            }}
          >
            Удалить
          </button>
        )}
      </form>
    </Dialog>
  );
}
