import { useEffect, useState } from "react";

export const COMPACT_COMPOSER = "(max-width: 767px), (hover: none) and (pointer: coarse)";

/** Keep the composer tools and its CSS layout in sync when rotating a phone. */
export function useCompactComposer(): boolean {
  const [compact, setCompact] = useState(() => !!window.matchMedia?.(COMPACT_COMPOSER).matches);
  useEffect(() => {
    const query = window.matchMedia?.(COMPACT_COMPOSER);
    if (!query) return;
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}
