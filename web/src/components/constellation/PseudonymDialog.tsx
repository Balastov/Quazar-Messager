import { useRef, useState } from "react";
import type { StarDetail, StarMember } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { apiErrorText } from "../../utils/profile";
import s from "./Constellation.module.css";

export function canEditPseudonym(myId: string | undefined, role: string, target: StarMember): boolean {
  return myId === target.user.id || ((role === "owner" || role === "admin") && target.role !== "owner" && target.role !== "admin");
}

export default function PseudonymDialog({ detail, member, onClose }: { detail: StarDetail; member: StarMember; onClose(): void }) {
  const myId = useAuthStore(state => state.user?.id);
  const live = useStarsStore(state => state.details[detail.id]) ?? detail;
  const target = live.members.find(item => item.user.id === member.user.id);
  const setPseudonym = useStarsStore(state => state.setMemberPseudonym);
  const [value, setValue] = useState(member.user.pseudonym ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const allowed = !!target && canEditPseudonym(myId, live.my_role, target);
  const save = async (pseudonym: string | null) => {
    if (!allowed || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { await setPseudonym(detail.id, member.user.id, pseudonym); onClose(); }
    catch (err) { setError(apiErrorText(err, "Не удалось сохранить псевдоним")); }
    finally { saving.current = false; setBusy(false); }
  };
  return <Dialog title={myId === member.user.id ? "Мой псевдоним в Звезде" : "Псевдоним участника"} onClose={onClose}>
    <form className={s.pseudonymForm} onSubmit={event => { event.preventDefault(); void save(value.trim() || null); }}>
      <p className={s.hint}>В Звезде «{detail.name}» этот псевдоним увидят все участники. Имя аккаунта и @{member.user.username} останутся прежними.</p>
      <label className={s.label}>Псевдоним
        <input className={s.input} value={value} maxLength={2048} autoFocus disabled={busy || !allowed}
          onChange={event => setValue(event.target.value)} placeholder={member.user.display_name || member.user.username} />
      </label>
      <p className={s.hint}>Любые видимые символы, включая эмодзи. От 3 до 64 символов; иероглифы — от одного. Действует проверка на недопустимые слова. Пустое поле убирает псевдоним.</p>
      {!allowed && <p className={s.error} role="alert">Этот псевдоним может изменить только сам участник.</p>}
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.dialogActions}>
        <button type="button" className={s.secondary} onClick={onClose}>Отмена</button>
        {target?.user.pseudonym && <button type="button" className={s.secondary} disabled={busy || !allowed} onClick={() => void save(null)}>Убрать псевдоним</button>}
        <button type="submit" className={s.primary} disabled={busy || !allowed}>{busy ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </form>
  </Dialog>;
}
