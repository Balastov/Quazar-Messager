import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { StarDetail, StarUser } from "../../api/stars";
import { displayName, type Named } from "../../utils/profile";

type Scope = { id: string; users: Map<string, StarUser> };
const StarProfilesContext = createContext<Scope | null>(null);

export function StarProfiles({ detail, children }: { detail?: Pick<StarDetail, "id" | "members">; children: ReactNode }) {
  const scope = useMemo(() => detail ? { id: detail.id, users: new Map(detail.members.map(member => [member.user.id, member.user])) } : null,
    [detail?.id, detail?.members]);
  return <StarProfilesContext.Provider value={scope}>{children}</StarProfilesContext.Provider>;
}

/** Resolve cached authors through the current membership, including rename/removal of an alias. */
export function useStarDisplayName(detail?: Pick<StarDetail, "id" | "members">): typeof displayName {
  const context = useContext(StarProfilesContext);
  return useCallback((user: Named | null | undefined) => {
    if (!user) return undefined;
    const scopeId = detail?.id ?? context?.id;
    const member = detail ? detail.members.find(item => item.user.id === user.id)?.user : user.id ? context?.users.get(user.id) : undefined;
    if (member) return displayName(member);
    if (scopeId && user.pseudonym_star_id && user.pseudonym_star_id !== scopeId) return displayName({ ...user, pseudonym: null, display_name: user.account_display_name || user.display_name });
    return displayName(user);
  }, [detail?.id, detail?.members, context]) as typeof displayName;
}
