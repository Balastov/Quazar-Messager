import { useEffect, useRef } from "react";
import type { StarChannel, StarDetail } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import SatelliteView from "./SatelliteView";
import { placeNouns } from "./words";
import s from "./Constellation.module.css";
import w from "./Work.module.css";

interface Props {
  detail: StarDetail;
  channel: StarChannel;
  /** Я сейчас в этой комнате: от этого зависит доступ к чату закрытой комнаты. */
  inside: boolean;
  onClose: () => void;
}

/** Чат комнаты справа от неё: та же лента, что у Спутника, — для тех, кто может войти. */
export default function RoomChat({ detail, channel, inside, onClose }: Props) {
  const error = useStarsStore((st) => st.roomChatError[channel.id]);
  const loaded = useStarsStore((st) => !!st.messages[channel.id]);
  const reload = useStarsStore((st) => st.reloadRoomChat);
  const nouns = placeNouns(detail.kind);
  const first = useRef(true);

  // Вошли в закрытую комнату или вышли из неё — доступ к чату мог измениться: грузим заново.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (loaded || error) return;
    }
    void reload(detail.id, channel.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, channel.id, inside, reload]);

  if (!error) return <SatelliteView detail={detail} channel={channel} room onClose={onClose} />;

  return (
    <div className={w.satelliteRoot}>
      <div className={s.channelHeader}>
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>💬 Чат</span>
        </div>
        <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Скрыть чат" title="Скрыть чат">
          ✕
        </button>
      </div>
      <div className={s.empty}>
        {error === "denied" ? (
          <>
            <div className={s.emptyTitle}>Чат закрыт</div>
            Переписку здесь видят те, кто может войти {nouns.into}. Когда вас впустят, она откроется.
          </>
        ) : (
          <>
            {error}{" "}
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => void reload(detail.id, channel.id)}>
              Повторить
            </button>
          </>
        )}
      </div>
    </div>
  );
}
