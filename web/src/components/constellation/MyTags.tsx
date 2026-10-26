import { useState } from "react";
import { starsApi, type StarDetail, type StarTag } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { apiError } from "./rules";
import g from "./Gaming.module.css";

/** Роли, которые можно выбрать себе самому («Танк», «Хил»…): нажатие — взять или снять. */
export default function MyTags({ detail }: { detail: StarDetail }) {
  const myId = useAuthStore((st) => st.user?.id);
  const [error, setError] = useState<string | null>(null);
  const choosable = (detail.tags ?? []).filter((t) => t.self_assign);
  const mine = detail.members.find((m) => m.user.id === myId)?.tag_ids ?? [];
  if (!choosable.length || !myId) return null;

  const toggle = (tag: StarTag) => {
    setError(null);
    const call = mine.includes(tag.id)
      ? starsApi.takeTag(detail.id, myId, tag.id)
      : starsApi.giveTag(detail.id, myId, tag.id);
    void call.catch((err) => setError(apiError(err)));
  };

  return (
    <div className={g.myTags}>
      <span className={g.myTagsTitle}>Мои роли</span>
      <div className={g.tagList}>
        {choosable.map((t) => (
          <TagChip key={t.id} tag={t} active={mine.includes(t.id)} onClick={() => toggle(t)} />
        ))}
      </div>
      {error && <span className={g.cardError}>{error}</span>}
    </div>
  );
}

export function TagChip({ tag, active = true, onClick }: { tag: StarTag; active?: boolean; onClick?: () => void }) {
  const style = { "--tag": tag.color } as React.CSSProperties;
  return onClick ? (
    <button type="button" className={active ? g.tagActive : g.tag} style={style} aria-pressed={active} onClick={onClick}>
      {tag.name}
    </button>
  ) : (
    <span className={g.tagActive} style={style}>
      {tag.name}
    </span>
  );
}

/** Цвет имени — по первой (верхней) своей роли участника. */
export function memberColor(detail: StarDetail, userId: string | undefined): string | undefined {
  if (!userId) return undefined;
  const ids = detail.members.find((m) => m.user.id === userId)?.tag_ids;
  if (!ids?.length) return undefined;
  return (detail.tags ?? []).find((t) => ids.includes(t.id))?.color;
}
