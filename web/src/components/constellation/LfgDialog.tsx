import { useEffect, useState } from "react";
import { starsApi, type StarDetail } from "../../api/stars";
import { toLocalInput } from "../../chat/when";
import { useAuthStore } from "../../store/auth";
import { useOfficeFloorStore } from "../../store/officeFloor";
import UserAvatar from "../UserAvatar";
import Dialog from "./Dialog";
import { lfgFloor, needsFloorPeople, organizerCandidates } from "./lfgOrganizers";
import { apiError } from "./rules";
import { useStarDisplayName } from "./StarProfiles";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";

/** Сбор группы: «Ищу пати: Dota, 5 мест, 21:00». */
export default function LfgDialog({ detail, channelId, onClose }: { detail: StarDetail; channelId: string; onClose: () => void }) {
  const myId = useAuthStore((st) => st.user?.id);
  const displayName = useStarDisplayName(detail);
  const isWork = detail.kind === "work";
  const [title, setTitle] = useState("");
  const [slots, setSlots] = useState(5);
  const [timed, setTimed] = useState(false);
  const [startsAt, setStartsAt] = useState(() => {
    const d = new Date(Date.now() + 3600_000);
    d.setMinutes(0, 0, 0);
    return toLocalInput(d);
  });
  const currentFloor = useOfficeFloorStore((st) => st.byStar[detail.id]);
  const [floorId, setFloorId] = useState(() => lfgFloor(detail.floors, currentFloor)?.id ?? null);
  const [byOther, setByOther] = useState(false);
  const [admins, setAdmins] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  // Кто бывает на этаже; null — все участники Звезды (этаж один или Звезда игровая).
  const [people, setPeople] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const floorPeople = needsFloorPeople(detail) && floorId;
  useEffect(() => {
    setPeople(null);
    if (!floorPeople) return;
    let active = true;
    void starsApi
      .floorPeople(detail.id, floorPeople)
      .then((ids) => {
        if (!active) return;
        setPeople(ids);
        // На другом этаже другие люди: недоступных снимаем.
        setAdmins((list) => list.filter((id) => ids.includes(id)));
      })
      .catch((err) => active && setError(apiError(err, "Не удалось узнать, кто бывает на этаже")));
    return () => {
      active = false;
    };
  }, [detail.id, floorPeople]);

  const loadingPeople = !!floorPeople && people === null;
  const candidates = loadingPeople ? [] : organizerCandidates(detail.members, people, myId, query);
  const chosen = admins
    .map((id) => detail.members.find((m) => m.user.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m);
  const needAdmins = byOther && admins.length === 0;
  const toggle = (id: string) => setAdmins((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || needAdmins) return;
    setBusy(true);
    setError(null);
    try {
      await starsApi.createLfg(detail.id, channelId, {
        title: title.trim(),
        slots,
        starts_at: timed ? new Date(startsAt).toISOString() : null,
        admin_ids: byOther ? admins : [],
        ...(isWork ? { floor_id: floorId } : {}),
      });
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось начать сбор"));
      setBusy(false);
    }
  };

  const place = isWork ? "Комната" : "Планета";
  return (
    <Dialog title="Сбор группы" onClose={onClose}>
      <form className={g.form} onSubmit={(e) => void submit(e)}>
        <p className={s.hint}>
          Участники записываются в сообщении. Когда сбор начнётся — по времени или по кнопке, —
          появится временная {place}: без стука туда входят записавшиеся и организаторы, остальных
          впускают организаторы.
        </p>
        <label className={s.label}>
          Во что и зачем
          <input className={s.input} value={title} maxLength={100} autoFocus placeholder={isWork ? "Ретро спринта" : "Dota 2, рейтинг"} onChange={(e) => setTitle(e.target.value)} />
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
        {isWork && detail.floors.length > 1 && (
          <label className={s.label}>
            Этаж
            <select className={s.select} value={floorId ?? ""} onChange={(e) => setFloorId(e.target.value)}>
              {detail.floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className={s.label} role="radiogroup" aria-label="Кто администрирует сбор?">
          Кто администрирует сбор?
          <div className={g.switch}>
            {[
              { other: false, label: "Я" },
              { other: true, label: "Другой пользователь" },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={byOther === option.other}
                className={`${g.switchOption} ${byOther === option.other ? g.switchOn : ""}`}
                onClick={() => setByOther(option.other)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className={s.checkHint}>
            {byOther
              ? "Выбранные впускают по стуку, зовут и могут начать или отменить сбор. Вы тоже остаётесь организатором."
              : "Вы впускаете по стуку, зовёте и можете начать или отменить сбор."}
          </span>
        </div>

        {byOther && (
          <div className={g.picker}>
            {chosen.length > 0 && (
              <div className={g.chips}>
                {chosen.map((m) => (
                  <button key={m.user.id} type="button" className={g.chip} onClick={() => toggle(m.user.id)} title="Убрать">
                    {displayName(m.user)} ✕
                  </button>
                ))}
              </div>
            )}
            <input
              className={s.input}
              value={query}
              placeholder={people ? "Найти на этаже: ник, имя" : "Найти в Звезде: ник, имя"}
              aria-label="Поиск организаторов"
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className={g.pickList} role="listbox" aria-multiselectable aria-label="Организаторы">
              {loadingPeople && <div className={g.pickEmpty}>Смотрим, кто бывает на этаже…</div>}
              {!loadingPeople && candidates.length === 0 && (
                <div className={g.pickEmpty}>{query ? "Никого не нашли" : "Больше никого нет"}</div>
              )}
              {candidates.map((m) => {
                const on = admins.includes(m.user.id);
                return (
                  <button
                    key={m.user.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`${g.pickRow} ${on ? g.pickRowOn : ""}`}
                    onClick={() => toggle(m.user.id)}
                  >
                    <UserAvatar username={displayName(m.user) ?? m.user.username} avatarUrl={m.user.avatar_url} size="sm" userId={m.user.id} />
                    <span className={g.pickName}>{displayName(m.user)}</span>
                    <span className={g.pickNick}>@{m.user.username}</span>
                    <span className={g.pickMark} aria-hidden>{on ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
            {needAdmins && <span className={s.checkHint}>Выберите хотя бы одного организатора</span>}
          </div>
        )}

        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={!title.trim() || busy || needAdmins}>
          Объявить сбор
        </button>
      </form>
    </Dialog>
  );
}
