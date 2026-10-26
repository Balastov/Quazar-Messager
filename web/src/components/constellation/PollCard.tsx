import { useState } from "react";
import type { StarDetail, StarMessage } from "../../api/stars";
import { starsApi } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { isStaff, useStarsStore } from "../../store/stars";
import { formatWhen } from "../../chat/when";
import { apiError } from "./rules";
import g from "./Gaming.module.css";

/** Опрос в Спутнике: голосование, полоски результатов, кто голосовал (если не анонимный). */
export default function PollCard({ message, detail }: { message: StarMessage; detail: StarDetail }) {
  const poll = message.poll!;
  const myId = useAuthStore((st) => st.user?.id);
  const vote = useStarsStore((st) => st.vote);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const voted = poll.my_votes.length > 0;
  const showResults = voted || poll.closed;
  const max = Math.max(1, ...poll.options.map((o) => o.votes));
  const nameOf = (id: string) => detail.members.find((m) => m.user.id === id)?.user.username ?? "участник";
  const canClose = !poll.closed && (poll.created_by === myId || isStaff(detail.my_role));

  const send = async (options: number[]) => {
    setError(null);
    try {
      await vote(message, options);
      setPicked([]);
    } catch (err) {
      setError(apiError(err, "Не удалось проголосовать"));
    }
  };

  const click = (i: number) => {
    if (poll.closed) return;
    if (!poll.multiple) return void send(poll.my_votes.includes(i) ? [] : [i]);
    if (voted) {
      const next = poll.my_votes.includes(i) ? poll.my_votes.filter((x) => x !== i) : [...poll.my_votes, i];
      return void send(next);
    }
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
  };

  return (
    <div className={g.card}>
      <div className={g.cardTitle}>📊 {poll.question}</div>
      <div className={g.cardMeta}>
        {poll.anonymous ? "Анонимный" : "Открытый"} · {poll.multiple ? "можно несколько" : "один вариант"}
        {poll.closed ? " · закрыт" : poll.closes_at ? ` · до ${formatWhen(poll.closes_at)}` : ""}
      </div>
      <div className={g.options}>
        {poll.options.map((o, i) => {
          const mine = poll.my_votes.includes(i) || picked.includes(i);
          return (
            <button
              key={i}
              type="button"
              className={mine ? g.optionMine : g.option}
              disabled={poll.closed}
              onClick={() => click(i)}
              title={!poll.anonymous && o.voters.length ? o.voters.map(nameOf).join(", ") : undefined}
            >
              {showResults && <span className={g.optionBar} style={{ width: `${(o.votes / max) * 100}%` }} />}
              <span className={g.optionText}>
                {poll.multiple ? (mine ? "☑ " : "☐ ") : mine ? "● " : "○ "}
                {o.text}
              </span>
              {showResults && <span className={g.optionCount}>{o.votes}</span>}
            </button>
          );
        })}
      </div>
      <div className={g.cardFooter}>
        <span>
          {poll.total_voters} {plural(poll.total_voters, "голос", "голоса", "голосов")}
        </span>
        {poll.multiple && !voted && picked.length > 0 && (
          <button type="button" className={g.cardAction} onClick={() => void send(picked)}>
            Проголосовать
          </button>
        )}
        {canClose && (
          <button
            type="button"
            className={g.cardLink}
            onClick={() => void starsApi.closePoll(message.star_id, poll.id).catch((err) => setError(apiError(err)))}
          >
            Закрыть опрос
          </button>
        )}
      </div>
      {error && <div className={g.cardError}>{error}</div>}
    </div>
  );
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
