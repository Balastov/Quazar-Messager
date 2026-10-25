/**
 * Реакции на сообщения — тот же набор, что на сервере (backend/app/core/reactions.py) и в web.
 */
export const REACTIONS = ['👍', '👎', '❤️', '🔥', '😂', '😮', '😢', '🎉'] as const;

export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Среди поставивших — я. */
  mine: boolean;
}

/** Реакции одной строкой чипов: по эмодзи, в порядке первой поставленной. */
export function groupReactions(
  reactions: {user_id: string; payload: string}[] | undefined,
  myId: string | undefined,
): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of reactions ?? []) {
    let g = groups.get(r.payload);
    if (!g) {
      g = {emoji: r.payload, count: 0, mine: false};
      groups.set(r.payload, g);
    }
    g.count += 1;
    if (r.user_id === myId) {
      g.mine = true;
    }
  }
  return [...groups.values()];
}

/** Моя реакция на сообщение, если есть. */
export function myReaction(
  reactions: {user_id: string; payload: string}[] | undefined,
  myId: string | undefined,
): string | null {
  return reactions?.find(r => r.user_id === myId)?.payload ?? null;
}

/** Та же, что уже стоит, — снять (null), иначе поставить или сменить. */
export function toggledReaction(current: string | null, picked: string): string | null {
  return current === picked ? null : picked;
}

/** Применить реакцию к списку: одна на человека. */
export function applyReaction<R extends {user_id: string}>(
  reactions: R[] | undefined,
  userId: string,
  next: R | null,
): R[] {
  const rest = (reactions ?? []).filter(r => r.user_id !== userId);
  return next ? [...rest, next] : rest;
}
