import { useEffect, useState } from "react";
import type { ScheduledStarMessage } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import { socket } from "../../ws/socket";
import { ScheduledList } from "../chat/ScheduledBar";
import { apiError } from "./rules";

const NONE: ScheduledStarMessage[] = [];

export default function StarScheduledBar({ starId, channelId }: { starId: string; channelId: string }) {
  const items = useStarsStore((st) => st.scheduled[channelId] ?? NONE);
  const load = useStarsStore((st) => st.loadScheduled);
  const cancel = useStarsStore((st) => st.cancelScheduled);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    const refresh = () => void load(starId, channelId).then(() => {
      if (active) setError(null);
    }).catch((err) => {
      if (active) setError(apiError(err, "Не удалось загрузить отложенные сообщения"));
    });
    refresh();
    const off = socket.onStatus((open) => { if (open) refresh(); });
    return () => { active = false; off(); };
  }, [starId, channelId, load]);

  return <ScheduledList key={channelId} items={items.map((x) => ({ ...x, sendAt: x.send_at }))}
    error={error} onCancel={(id) => cancel(starId, channelId, id)} />;
}
