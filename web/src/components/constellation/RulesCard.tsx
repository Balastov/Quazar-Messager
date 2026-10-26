import { useState } from "react";
import type { StarDetail } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import { useAuthStore } from "../../store/auth";
import MyTags from "./MyTags";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";

/** Вместо поля ввода, пока новичок не принял правила: текст правил, выбор своих ролей, «Согласен». */
export default function RulesCard({ detail }: { detail: StarDetail }) {
  const acceptRules = useStarsStore((st) => st.acceptRules);
  const myId = useAuthStore((st) => st.user?.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className={g.rules}>
      <div className={g.rulesTitle}>Правила «{detail.name}»</div>
      <div className={g.rulesText}>{detail.rules_text}</div>
      {myId && <MyTags detail={detail} />}
      {error && <div className={s.error}>{error}</div>}
      <button
        type="button"
        className={s.primary}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void acceptRules(detail.id).catch((err) => {
            setError(apiError(err));
            setBusy(false);
          });
        }}
      >
        Прочитал(а), согласен(на)
      </button>
    </div>
  );
}
