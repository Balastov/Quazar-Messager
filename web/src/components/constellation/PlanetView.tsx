import type { StarChannel, StarDetail } from "../../api/stars";
import { IconBack, IconPlanet } from "../icons";
import { can, ROOM_LABEL } from "./rules";
import s from "./Constellation.module.css";

interface Props {
  detail: StarDetail;
  channel: StarChannel;
  onBack?: () => void;
  onEdit: () => void;
}

/** Голос на Планетах появится на этапе 2 — пока карточка с параметрами комнаты. */
export default function PlanetView({ detail, channel, onBack, onEdit }: Props) {
  const room = channel.room_kind ? ROOM_LABEL[channel.room_kind] : null;
  return (
    <>
      <div className={s.channelHeader}>
        {onBack && (
          <button type="button" className={s.iconBtn} onClick={onBack} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <IconPlanet />
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>{channel.name}</span>
          <span className={s.channelTitleSub}>Планета · {detail.name}</span>
        </div>
      </div>
      <div className={s.planet}>
        <div className={s.planetIcon}>
          <IconPlanet size={44} />
        </div>
        <div className={s.planetName}>{channel.name}</div>
        <div>
          {room ? `${room} · ` : ""}до {channel.capacity ?? "—"} человек
        </div>
        <p className={s.hint}>
          Голосовая связь на Планетах появится в следующем обновлении. Тогда сюда можно будет
          зайти и поговорить со всеми, кто внутри.
        </p>
        {can(detail, "manage_channels") && (
          <button type="button" className={s.secondary} onClick={onEdit}>
            Изменить Планету
          </button>
        )}
      </div>
    </>
  );
}
