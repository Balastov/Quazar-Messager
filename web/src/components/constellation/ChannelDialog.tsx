import { useState } from "react";
import type {
  ChannelKind,
  RoomAccess,
  RoomKind,
  StarChannel,
  StarFloor,
  StarKind,
  StarMember,
} from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { ConnectShared, ShareSection } from "./ChannelShare";
import { apiError, ROOM_LABEL, SELECTABLE_ROOM_KINDS } from "./rules";
import s from "./Constellation.module.css";
import { placeNouns } from "./words";
import { compareUsers, displayName } from "../../utils/profile";

const ROOM_KINDS = SELECTABLE_ROOM_KINDS;

interface Props {
  starKind: StarKind;
  kind: ChannelKind;
  /** Есть — редактируем, нет — создаём. */
  channel?: StarChannel;
  /** Этажи карты офиса (Звёзды «Работа»). */
  floors?: StarFloor[];
  defaultFloorId?: string;
  /** Переносить комнату между этажами может тот, кто редактирует карту. */
  canEditMap?: boolean;
  /** Участники Звезды — из них выбирают хозяина личного кабинета. */
  members?: StarMember[];
  /** Звезда, в которой открыт диалог: общий доступ и подключение по коду. */
  starId?: string;
  onClose: () => void;
}

export default function ChannelDialog({
  starKind,
  kind,
  channel,
  floors = [],
  defaultFloorId,
  canEditMap = false,
  members = [],
  starId,
  onClose,
}: Props) {
  const limits = useStarsStore((st) => st.limits);
  const createChannel = useStarsStore((st) => st.createChannel);
  const updateChannel = useStarsStore((st) => st.updateChannel);
  const deleteChannel = useStarsStore((st) => st.deleteChannel);

  const isPlanet = kind === "planet";
  const isWork = starKind === "work";
  const nouns = placeNouns(starKind);
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
  const [floorId, setFloorId] = useState<string>(
    channel?.floor_id ?? defaultFloorId ?? floors[0]?.id ?? ""
  );
  const showFloors = kind === "planet" && starKind === "work" && floors.length > 0;
  const isLobby = channel?.room_kind === "lobby";
  const [access, setAccess] = useState<RoomAccess>(channel?.access ?? "open");
  const [cabinetOwnerId, setCabinetOwnerId] = useState<string>(channel?.cabinet_owner_id ?? "");
  const [listenOnly, setListenOnly] = useState<boolean>(channel?.listen_only ?? false);
  const [slowMode, setSlowMode] = useState<number>(channel?.slow_mode_sec ?? 0);
  const [announcement, setAnnouncement] = useState<boolean>(channel?.announcement ?? false);
  const sortedMembers = [...members].sort((a, b) => compareUsers(a.user, b.user));
  const floorEditable = !channel || canEditMap;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = channel
    ? isPlanet
      ? `Изменить ${nouns.acc}`
      : "Изменить Спутник"
    : isPlanet
      ? nouns.created
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
    if (access === "personal" && !cabinetOwnerId) {
      setError("Выберите, чей это кабинет");
      return;
    }
    const floorChanged = showFloors && floorId && floorId !== (channel?.floor_id ?? "");
    const planetFields = isPlanet
      ? {
          capacity,
          ...(isWork && !isLobby ? { room_kind: roomKind } : {}),
          ...(isLobby ? {} : { access }),
          ...(!isLobby && access === "personal" ? { cabinet_owner_id: cabinetOwnerId } : {}),
          listen_only: listenOnly,
          ...(floorChanged && floorEditable ? { floor_id: floorId } : {}),
        }
      : {};
    void run(() =>
      channel
        ? updateChannel(channel.id, {
            name: trimmed,
            ...planetFields,
            ...(isPlanet ? {} : { slow_mode_sec: slowMode, announcement }),
          })
        : createChannel({ kind, name: trimmed, ...planetFields, ...(isPlanet ? {} : { announcement }) })
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

        {isPlanet && !isLobby && (
          <label className={s.label}>
            Вход
            <select
              className={s.select}
              value={access}
              onChange={(e) => setAccess(e.target.value as RoomAccess)}
              disabled={busy}
            >
              <option value="open">Свободный вход</option>
              <option value="invite">По приглашениям — стучаться</option>
              {isWork && <option value="personal">Личный кабинет</option>}
            </select>
            <span className={s.checkHint}>
              {access === "invite"
                ? `${isWork ? "В пустую Комнату" : "На пустую Планету"} заходит кто угодно и становится главным. Пока внутри кто-то есть, остальные стучатся — впускает и зовёт главный.`
                : access === "personal"
                  ? "Без стука входит только хозяин кабинета. Звать и впускать могут хозяин, админы и владелец Звезды."
                  : "Заходит любой участник Звезды."}
            </span>
          </label>
        )}

        {isPlanet && !isLobby && access === "personal" && (
          <label className={s.label}>
            Чей кабинет
            <select
              className={s.select}
              value={cabinetOwnerId}
              onChange={(e) => setCabinetOwnerId(e.target.value)}
              disabled={busy}
              required
            >
              <option value="" disabled>
                Выберите хозяина кабинета
              </option>
              {sortedMembers.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {displayName(m.user)}
                </option>
              ))}
            </select>
          </label>
        )}

        {isPlanet && isWork && !isLobby && (
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

        {showFloors && (
          <label className={s.label}>
            Этаж
            <select
              className={s.select}
              value={floorId}
              onChange={(e) => setFloorId(e.target.value)}
              disabled={busy || !floorEditable}
              title={floorEditable ? undefined : "Переносить между этажами может тот, кто редактирует карту"}
            >
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
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

        {isPlanet && (
          <label className={s.checkRow}>
            <input
              type="checkbox"
              checked={listenOnly}
              onChange={(e) => setListenOnly(e.target.checked)}
              disabled={busy}
            />
            <span>
              🎧 Только слушать
              <span className={s.checkHint}>
                Микрофоны {nouns.inside} не включаются вообще — браузер их даже не запрашивает.
                Показывать экран можно. Подходит для кинозала, трансляций и тихой работы рядом.
              </span>
            </span>
          </label>
        )}

        {!isPlanet && (
          <label className={s.checkRow}>
            <input
              type="checkbox"
              checked={announcement}
              onChange={(e) => setAnnouncement(e.target.checked)}
              disabled={busy}
            />
            <span>
              📢 Канал объявлений
              <span className={s.checkHint}>
                Пишут только владелец и админы, остальные обсуждают в ветках под объявлениями. Можно
                попросить отметить «Ознакомлен(а)» и посмотреть, кто ещё не прочитал.
              </span>
            </span>
          </label>
        )}

        {!isPlanet && channel && (
          <label className={s.label}>
            🐢 Медленный режим
            <select className={s.select} value={slowMode} onChange={(e) => setSlowMode(Number(e.target.value))} disabled={busy}>
              <option value={0}>Выключен</option>
              <option value={10}>10 секунд</option>
              <option value={30}>30 секунд</option>
              <option value={60}>1 минута</option>
              <option value={300}>5 минут</option>
            </select>
            <span className={s.hint}>Один человек — не чаще одного сообщения за это время. Модераторов не касается.</span>
          </label>
        )}

        {!isPlanet && channel && starId && <ShareSection starId={starId} channel={channel} />}
        {!isPlanet && !channel && starId && <ConnectShared starId={starId} onDone={onClose} />}

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
              const what = isPlanet ? nouns.acc : "Спутник и всю его переписку";
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
