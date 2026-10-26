import { useEffect, useMemo, useState } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useDoorsStore } from "../../store/doors";
import { useStarsStore } from "../../store/stars";
import { useVoiceStore } from "../../store/voice";
import { IconBack } from "../icons";
import {
  fits,
  GRID_H,
  GRID_W,
  moveRect,
  rectOf,
  resizeRect,
  ROOM_ICON,
  sameRect,
  type Rect,
} from "./office";
import { apiError, can, doorKind, initials, roomDoor } from "./rules";
import s from "./Constellation.module.css";
import w from "./Work.module.css";
import { currentBooking, doorSign, hhmm, useBookings } from "./work";

interface Props {
  detail: StarDetail;
  onBack?: () => void;
  /** Открыть экран комнаты (участники, модерация). */
  onOpenPlanet: (channel: StarChannel) => void;
  /** Добавить комнату на этаж. */
  onAddRoom: (floorId: string) => void;
}

interface Drag {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  start: Rect;
}

const BASE_CELL = 28;
const ZOOMS = [0.6, 0.8, 1, 1.25, 1.5];

export default function OfficeMap({ detail, onBack, onOpenPlanet, onAddRoom }: Props) {
  const myId = useAuthStore((st) => st.user?.id);
  const voice = useVoiceStore();
  const createFloor = useStarsStore((st) => st.createFloor);
  const renameFloor = useStarsStore((st) => st.renameFloor);
  const deleteFloor = useStarsStore((st) => st.deleteFloor);
  const saveLayout = useStarsStore((st) => st.saveLayout);
  const refreshStar = useStarsStore((st) => st.refreshStar);
  const myKnock = useDoorsStore((st) => st.myKnock);
  const { bookings, now } = useBookings(detail);

  const floors = detail.floors;
  const [floorId, setFloorId] = useState<string | null>(floors[0]?.id ?? null);
  const floor = floors.find((f) => f.id === floorId) ?? floors[0];
  const [zoomIndex, setZoomIndex] = useState(() =>
    window.matchMedia("(max-width: 767px)").matches ? 1 : 2
  );
  const cell = BASE_CELL * ZOOMS[zoomIndex];

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, Rect>>({});
  const [editVersion, setEditVersion] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const canEdit = can(detail, "edit_map");
  const canAddRooms = can(detail, "manage_channels");
  const isClosed = (c: StarChannel) => doorKind(c) !== "open";
  const mustKnock = (c: StarChannel) => !roomDoor(detail, c, myId).entersFreely;

  useEffect(() => {
    if (floorId && !floors.some((f) => f.id === floorId)) setFloorId(floors[0]?.id ?? null);
  }, [floors, floorId]);

  const rooms = useMemo(
    () => detail.channels.filter((c) => c.kind === "planet" && c.floor_id === floor?.id),
    [detail.channels, floor?.id]
  );
  const placed = rooms.filter((c) => rectOf(c));
  const unplaced = rooms.filter((c) => !rectOf(c));

  const rectFor = (c: StarChannel): Rect => (editing && draft[c.id]) || rectOf(c)!;
  const memberName = (userId: string) =>
    detail.members.find((m) => m.user.id === userId)?.user.username ??
    Object.values(detail.voice ?? {})
      .flat()
      .find((p) => p.user_id === userId)?.guest_name ??
    "?";
  const iAmIn = (c: StarChannel) => voice.channelId === c.id && voice.status !== "idle";

  const startEditing = () => {
    setDraft(Object.fromEntries(placed.map((c) => [c.id, rectOf(c)!])));
    setEditVersion(floor?.version ?? 0);
    setError(null);
    setStale(false);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft({});
    setDrag(null);
    setError(null);
    setStale(false);
  };

  // Кто-то другой поменял план, пока вы его правите.
  useEffect(() => {
    if (editing && floor && floor.version !== editVersion) setStale(true);
  }, [editing, floor, editVersion]);

  const save = async () => {
    if (!floor) return;
    setBusy(true);
    setError(null);
    try {
      await saveLayout(
        floor.id,
        editVersion,
        placed.map((c) => ({ channel_id: c.id, ...draft[c.id] }))
      );
      setEditing(false);
      setDraft({});
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const reloadPlan = async () => {
    await refreshStar(detail.id);
    cancelEditing();
  };

  const onPointerDown = (e: React.PointerEvent, c: StarChannel, mode: Drag["mode"]) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: c.id, mode, startX: e.clientX, startY: e.clientY, start: rectFor(c) });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = Math.round((e.clientX - drag.startX) / cell);
    const dy = Math.round((e.clientY - drag.startY) / cell);
    const next = drag.mode === "move" ? moveRect(drag.start, dx, dy) : resizeRect(drag.start, dx, dy);
    const others = placed.filter((c) => c.id !== drag.id).map((c) => draft[c.id] ?? rectOf(c)!);
    if (fits(next, others)) {
      setBlocked(null);
      if (!sameRect(next, draft[drag.id])) setDraft((d) => ({ ...d, [drag.id]: next }));
    } else {
      // На занятое место не ставим — комната остаётся на последнем свободном.
      setBlocked(drag.id);
    }
  };

  const onPointerUp = () => {
    setDrag(null);
    setBlocked(null);
  };

  const onRoomClick = (c: StarChannel) => {
    if (editing) return;
    if (iAmIn(c)) {
      onOpenPlanet(c);
      return;
    }
    // Войти — или постучаться, если дверь закрыта.
    void useDoorsStore.getState().enterRoom(detail, c);
  };

  const addFloor = async () => {
    const name = window.prompt("Название этажа", `${floors.length + 1} этаж`)?.trim();
    if (!name) return;
    try {
      const id = await createFloor(name);
      if (id) setFloorId(id);
    } catch (err) {
      setError(apiError(err));
    }
  };

  const editFloorName = async () => {
    if (!floor) return;
    const name = window.prompt("Новое название этажа", floor.name)?.trim();
    if (!name || name === floor.name) return;
    try {
      await renameFloor(floor.id, name);
    } catch (err) {
      setError(apiError(err));
    }
  };

  const removeFloor = async () => {
    if (!floor) return;
    if (!window.confirm(`Удалить «${floor.name}»? Его Комнаты переедут на другой этаж.`)) return;
    try {
      await deleteFloor(floor.id);
    } catch (err) {
      setError(apiError(err));
    }
  };

  return (
    <div className={s.map}>
      <div className={s.channelHeader}>
        {onBack && (
          <button type="button" className={s.iconBtn} onClick={onBack} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <span aria-hidden>🗺</span>
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>Карта офиса</span>
          <span className={s.channelTitleSub}>
            {editing
              ? "Перетаскивайте Комнаты, растягивайте за правый нижний угол"
              : "Нажмите на Комнату, чтобы войти"}
          </span>
        </div>
      </div>

      <div className={s.mapToolbar}>
        <div className={s.floorTabs} role="tablist" aria-label="Этажи">
          {floors.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={f.id === floor?.id}
              className={f.id === floor?.id ? s.floorTabActive : s.floorTab}
              onClick={() => !editing && setFloorId(f.id)}
              disabled={editing && f.id !== floor?.id}
            >
              {f.name}
              {canEdit && !editing && f.id === floor?.id && (
                <>
                  <span
                    role="button"
                    tabIndex={0}
                    className={s.floorTabTool}
                    title="Переименовать этаж"
                    onClick={(e) => {
                      e.stopPropagation();
                      void editFloorName();
                    }}
                  >
                    ✎
                  </span>
                  {floors.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      className={s.floorTabTool}
                      title="Удалить этаж"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeFloor();
                      }}
                    >
                      ✕
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
          {canEdit && !editing && (
            <button type="button" className={s.floorTab} onClick={() => void addFloor()}>
              + Этаж
            </button>
          )}
        </div>
        <div className={s.zoom}>
          <button
            type="button"
            className={`${s.secondary} ${s.small}`}
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            aria-label="Мельче"
          >
            −
          </button>
          <button
            type="button"
            className={`${s.secondary} ${s.small}`}
            onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOMS.length - 1}
            aria-label="Крупнее"
          >
            +
          </button>
        </div>
      </div>

      <div className={s.mapViewport}>
        <div
          className={s.mapGrid}
          style={{
            width: GRID_W * cell,
            height: GRID_H * cell,
            backgroundSize: `${cell}px ${cell}px`,
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {placed.map((c) => {
            const r = rectFor(c);
            const inside = detail.voice?.[c.id] ?? [];
            const capacity = c.capacity ?? 10;
            const mine = iAmIn(c) || inside.some((p) => p.user_id === myId);
            const full = inside.length >= capacity && !mine;
            const locked = mustKnock(c) && !mine;
            const knocking = myKnock?.channelId === c.id;
            const booked = currentBooking(bookings, c.id, now);
            const sign = doorSign(c, now);
            const extra = [
              booked ? `занято до ${hhmm(booked.ends_at)}: «${booked.title}»` : "",
              sign ? `${sign.icon} ${sign.text}` : "",
            ]
              .filter(Boolean)
              .map((x) => ` · ${x}`)
              .join("");
            const classes = [
              s.room,
              inside.length ? s.roomOccupied : "",
              mine ? s.roomMine : "",
              full && !editing ? s.roomFull : "",
              editing ? s.roomEditing : "",
              drag?.id === c.id ? s.roomDragging : "",
              blocked === c.id ? s.roomBlocked : "",
            ];
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className={classes.filter(Boolean).join(" ")}
                style={{ left: r.x * cell, top: r.y * cell, width: r.w * cell, height: r.h * cell }}
                title={
                  (editing
                    ? c.name
                    : mine
                      ? `${c.name} — вы здесь`
                      : full
                        ? `${c.name} — заполнена`
                        : knocking
                          ? `${c.name} — вы постучались, ждём ответа`
                          : locked
                            ? `${c.name} — ${doorKind(c) === "personal" ? "личный кабинет" : "по приглашениям"}, нажмите, чтобы постучаться`
                            : `Войти в ${c.name}`) + (editing ? "" : extra)
                }
                onPointerDown={(e) => onPointerDown(e, c, "move")}
                onClick={() => onRoomClick(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRoomClick(c);
                }}
              >
                <div className={s.roomHead}>
                  <span aria-hidden>{ROOM_ICON[c.room_kind ?? "custom"]}</span>
                  <span className={s.roomName}>{c.name}</span>
                  {sign && !editing && <span aria-label={sign.text}>{sign.icon}</span>}
                  {isClosed(c) && (
                    <span
                      className={s.lock}
                      aria-label={doorKind(c) === "personal" ? "личный кабинет" : "по приглашениям"}
                    >
                      {knocking ? "✊" : doorKind(c) === "personal" ? "🔑" : "🔒"}
                    </span>
                  )}
                  <span className={s.roomCount}>
                    {inside.length}/{capacity}
                  </span>
                </div>
                {booked && !editing && (
                  <div className={w.busyBadge}>
                    📅 до {hhmm(booked.ends_at)} · {booked.title}
                  </div>
                )}
                {inside.length > 0 && r.h >= 2 && (
                  <div className={s.roomPeople}>
                    {inside.slice(0, 6).map((p) => (
                      <span key={p.user_id} className={s.roomPerson} title={memberName(p.user_id)}>
                        {initials(memberName(p.user_id))}
                      </span>
                    ))}
                    {inside.length > 6 && <span className={s.roomCount}>+{inside.length - 6}</span>}
                  </div>
                )}
                {!editing && (
                  <button
                    type="button"
                    className={s.roomInfo}
                    title="Кто внутри и настройки Комнаты"
                    aria-label={`Открыть «${c.name}»`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPlanet(c);
                    }}
                  >
                    ⋯
                  </button>
                )}
                {editing && (
                  <span
                    className={s.roomResize}
                    aria-label="Растянуть"
                    onPointerDown={(e) => onPointerDown(e, c, "resize")}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className={s.mapFooter}>
        {unplaced.length > 0 && canEdit && (
          <p className={s.hint}>
            Не поместились на этаж: {unplaced.map((c) => `«${c.name}»`).join(", ")}. Освободите
            место или перенесите их на другой этаж в настройках Комнаты.
          </p>
        )}
        {voice.error && !editing && <div className={s.error}>{voice.error}</div>}
        {stale && (
          <div className={s.error}>
            Пока вы редактировали, план этого этажа изменил кто-то другой.{" "}
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => void reloadPlan()}>
              Обновить карту
            </button>
          </div>
        )}
        {error && <div className={s.error}>{error}</div>}
        <div className={s.row}>
          {canEdit && !editing && floor && (
            <button type="button" className={s.secondary} onClick={startEditing}>
              Изменить план
            </button>
          )}
          {canAddRooms && floor && !editing && (
            <button type="button" className={s.secondary} onClick={() => onAddRoom(floor.id)}>
              + Комната
            </button>
          )}
          {editing && (
            <>
              <button type="button" className={s.primary} onClick={() => void save()} disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить план"}
              </button>
              <button type="button" className={s.secondary} onClick={cancelEditing} disabled={busy}>
                Отмена
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
