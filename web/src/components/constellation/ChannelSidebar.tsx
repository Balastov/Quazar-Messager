import type { ChannelKind, StarChannel, StarDetail } from "../../api/stars";
import { sortChannels, useStarsStore } from "../../store/stars";
import { IconGear, IconPlanet, IconSatellite } from "../icons";
import { can, GAMING_LIMITS, initials, KIND_LABEL, ROLE_LABEL } from "./rules";
import { VoiceBar } from "./VoiceBar";
import s from "./Constellation.module.css";

interface Props {
  detail: StarDetail;
  activeChannelId: string | null;
  onOpenChannel: (channel: StarChannel) => void;
  onAddChannel: (kind: ChannelKind) => void;
  onEditChannel: (channel: StarChannel) => void;
  onOpenSettings: (tab?: "invites") => void;
}

export default function ChannelSidebar({
  detail,
  activeChannelId,
  onOpenChannel,
  onAddChannel,
  onEditChannel,
  onOpenSettings,
}: Props) {
  const unread = useStarsStore((st) => st.unread);
  const channels = sortChannels(detail.channels);
  const manage = can(detail, "manage_channels");

  const section = (kind: ChannelKind, title: string) => {
    const list = channels.filter((c) => c.kind === kind);
    const limit = detail.kind === "gaming" ? GAMING_LIMITS[kind] : null;
    const full = limit !== null && list.length >= limit;
    return (
      <>
        <div className={s.section}>
          <span>
            {title}
            {limit !== null ? ` · ${list.length}/${limit}` : ""}
          </span>
          {manage && (
            <button
              type="button"
              className={s.sectionAdd}
              onClick={() => onAddChannel(kind)}
              disabled={full}
              title={
                full
                  ? `В игровой Звезде не больше ${limit}`
                  : kind === "satellite"
                    ? "Добавить Спутник"
                    : "Добавить Планету"
              }
              aria-label={kind === "satellite" ? "Добавить Спутник" : "Добавить Планету"}
            >
              +
            </button>
          )}
        </div>
        {list.map((c) => {
          const count = unread[c.id]?.count ?? 0;
          const inside = kind === "planet" ? (detail.voice?.[c.id] ?? []) : [];
          return (
            <div key={c.id}>
              <button
                type="button"
                className={c.id === activeChannelId ? s.channelActive : s.channel}
                onClick={() => onOpenChannel(c)}
                onDoubleClick={manage ? () => onEditChannel(c) : undefined}
              >
                {kind === "satellite" ? <IconSatellite /> : <IconPlanet />}
                <span className={`${s.channelName} ${count ? s.channelUnread : ""}`}>{c.name}</span>
                {kind === "planet" && (
                  <span className={s.channelHint}>
                    {inside.length ? `${inside.length}/${c.capacity}` : `до ${c.capacity}`}
                  </span>
                )}
                {count > 0 && <span className={s.countBadge}>{count > 99 ? "99+" : count}</span>}
              </button>
              {inside.length > 0 && (
                <div className={s.presence}>
                  {inside.map((p) => {
                    const name =
                      detail.members.find((m) => m.user.id === p.user_id)?.user.username ?? "Участник";
                    return (
                      <div key={p.user_id} className={s.presenceRow}>
                        <span className={s.presenceDot}>{initials(name)}</span>
                        <span className={s.presenceName}>{name}</span>
                        {p.server_muted && <span title="Микрофон выключил модератор">🔇</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {list.length === 0 && (
          <div className={s.channelHint} style={{ padding: "6px 10px" }}>
            {kind === "satellite" ? "Спутников нет" : "Планет нет"}
          </div>
        )}
      </>
    );
  };

  return (
    <div className={s.sidebar}>
      <div className={s.sidebarHeader}>
        <div className={s.starTitle}>
          <span className={s.starName}>{detail.name}</span>
          <span className={s.starMeta}>
            {KIND_LABEL[detail.kind]} · {detail.member_count} уч. · {ROLE_LABEL[detail.my_role]}
          </span>
        </div>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => onOpenSettings()}
          aria-label="Настройки Звезды"
          title="Настройки Звезды"
        >
          <IconGear />
        </button>
      </div>
      <div className={s.channels}>
        {section("satellite", "Спутники")}
        {section("planet", "Планеты")}
      </div>
      <div className={s.sidebarFooter} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <VoiceBar />
        {can(detail, "invite") && (
          <button
            type="button"
            className={`${s.secondary} ${s.wide}`}
            onClick={() => onOpenSettings("invites")}
          >
            Пригласить людей
          </button>
        )}
      </div>
    </div>
  );
}
