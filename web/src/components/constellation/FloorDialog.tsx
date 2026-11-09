import { useEffect, useMemo, useState } from "react";
import { starsApi, type FloorAccess, type StarDetail, type StarFloor, type StarMember } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import { compareUsers, displayName } from "../../utils/profile";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import s from "./Constellation.module.css";

/** Владельцу, админам и тем, кто редактирует карту, открыты все этажи — их не настраивают. */
export function seesAllFloors(detail: StarDetail, member: StarMember): boolean {
  if (member.role === "owner" || member.role === "admin") return true;
  return member.role === "moderator" && detail.role_permissions.moderator.includes("edit_map");
}

export const FLOOR_ACCESS_LABEL: Record<FloorAccess, string> = {
  all: "Доступен всем",
  none: "Не доступен никому",
};

const FLOOR_ACCESS_HINT: Record<FloorAccess, string> = {
  all: "Этаж и его Комнаты видят все участники Звезды, в том числе новые.",
  none: "Этаж видят только владелец, админы и те, кто редактирует карту. Участников можно добавить в настройках доступа.",
};

function AccessChoice({
  value,
  onChange,
  disabled,
}: {
  value: FloorAccess | null;
  onChange: (next: FloorAccess) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className={s.list} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={s.label}>Доступ участников</legend>
      {(["all", "none"] as const).map((option) => (
        <label key={option} className={s.checkRow}>
          <input
            type="radio"
            name="floor-access"
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
            disabled={disabled}
            required
          />
          <span>
            {option === "all" ? "🔓" : "🔒"} {FLOOR_ACCESS_LABEL[option]}
            <span className={s.checkHint}>{FLOOR_ACCESS_HINT[option]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Новый этаж: название и обязательный выбор — открыт всем или никому. */
export function CreateFloorDialog({
  defaultName,
  onClose,
  onCreated,
}: {
  defaultName: string;
  onClose: () => void;
  onCreated: (floorId: string) => void;
}) {
  const createFloor = useStarsStore((st) => st.createFloor);
  const [name, setName] = useState(defaultName);
  const [access, setAccess] = useState<FloorAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !access) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createFloor(trimmed, access);
      if (id) onCreated(id);
      onClose();
    } catch (err) {
      setError(apiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Новый этаж" onClose={onClose}>
      <form className={s.list} onSubmit={(e) => void submit(e)}>
        <label className={s.label}>
          Название
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
            autoFocus
            disabled={busy}
          />
        </label>
        <AccessChoice value={access} onChange={setAccess} disabled={busy} />
        {!access && <span className={s.hint}>Выберите, кому будет доступен этаж.</span>}
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={busy || !name.trim() || !access}>
          {busy ? "Создаём…" : "Создать этаж"}
        </button>
      </form>
    </Dialog>
  );
}

/** Кому открыт этаж: доступ по умолчанию и отметки отдельных участников. */
export function FloorAccessDialog({
  detail,
  floor,
  onClose,
}: {
  detail: StarDetail;
  floor: StarFloor;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<FloorAccess | null>(null);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = useMemo(
    () => [...detail.members].sort((a, b) => compareUsers(a.user, b.user)),
    [detail.members]
  );
  const configurable = members.filter((m) => !seesAllFloors(detail, m));
  const always = members.filter((m) => seesAllFloors(detail, m));

  useEffect(() => {
    let alive = true;
    starsApi
      .floorAccess(detail.id, floor.id)
      .then((out) => {
        if (!alive) return;
        setAccess(out.access);
        setAllowed(new Set(out.user_ids));
      })
      .catch((err) => alive && setError(apiError(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [detail.id, floor.id]);

  // Сменили доступ по умолчанию — отметки начинаются с него, исключения снимаются.
  const chooseDefault = (next: FloorAccess) => {
    setAccess(next);
    setAllowed(next === "all" ? new Set(configurable.map((m) => m.user.id)) : new Set());
  };

  const toggle = (userId: string) =>
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!access) return;
    setBusy(true);
    setError(null);
    try {
      await starsApi.setFloorAccess(detail.id, floor.id, access, [...allowed]);
      onClose();
    } catch (err) {
      setError(apiError(err));
      setBusy(false);
    }
  };

  const exceptions = configurable.filter((m) => allowed.has(m.user.id) !== (access === "all")).length;

  return (
    <Dialog title={`Доступ: ${floor.name}`} onClose={onClose}>
      <form className={s.list} onSubmit={(e) => void save(e)}>
        {loading ? (
          <span className={s.hint}>Загружаем…</span>
        ) : (
          <>
            <AccessChoice value={access} onChange={chooseDefault} disabled={busy} />
            <div className={s.label}>
              Участники с доступом
              <span className={s.checkHint}>
                Без доступа участник не видит этаж и его Комнаты, не входит и не стучится в них.
                Гостевые ссылки работают как раньше — только в свою Комнату.
              </span>
            </div>
            {configurable.length === 0 && <span className={s.hint}>Все участники видят этот этаж по своей роли.</span>}
            {configurable.map((m) => (
              <label key={m.user.id} className={s.checkRow}>
                <input
                  type="checkbox"
                  checked={allowed.has(m.user.id)}
                  onChange={() => toggle(m.user.id)}
                  disabled={busy}
                />
                <span>{displayName(m.user)}</span>
              </label>
            ))}
            {always.length > 0 && (
              <span className={s.hint}>
                Всегда видят все этажи: {always.map((m) => displayName(m.user)).join(", ")}.
              </span>
            )}
            {exceptions > 0 && (
              <span className={s.hint}>
                {access === "all" ? "Закрыт для" : "Открыт для"}: {exceptions}{" "}
                {exceptions === 1 ? "участника" : "участников"}.
              </span>
            )}
          </>
        )}
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={busy || loading || !access}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
      </form>
    </Dialog>
  );
}
