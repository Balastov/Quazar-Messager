import { useState } from "react";
import type { ChannelKind, StarChannel, StarDetail } from "../../api/stars";
import { useDoorsStore } from "../../store/doors";
import { sortChannels, useStarsStore } from "../../store/stars";
import { IconContacts, IconGear, IconPlanet, IconSatellite } from "../icons";
import { usePresenceStore } from "../../store/presence";
import { useVoiceStore } from "../../store/voice";
import { apiError, can, GAMING_LIMITS, initials, KIND_LABEL, ROLE_LABEL } from "./rules";
import { starsApi } from "../../api/stars";
import { VoiceBar } from "./VoiceBar";
import { placeNouns, roomWords } from "./words";
import { currentBooking, doorSign, hhmm, useBookings } from "./work";
import NotifyDialog from "../NotifyDialog";
import { channelLevel, starLevel, STAR_DEFAULT, useNotifyStore } from "../../notifications/levels";
import s from "./Constellation.module.css";

interface Props {
  detail: StarDetail;
  activeChannelId: string | null;
  /** Открыта карта офиса (Звёзды «Работа»). */
  mapActive?: boolean;
  onOpenMap?: () => void;
  /** Открыт раздел «Файлы». */
  filesActive?: boolean;
  onOpenFiles: () => void;
  onOpenChannel: (channel: StarChannel) => void;
  onAddChannel: (kind: ChannelKind) => void;
  onEditChannel: (channel: StarChannel) => void;
  onOpenSettings: (tab?: "invites") => void;
  /** Показать или скрыть участников со статусами. */
  onToggleMembers: () => void;
  membersOpen: boolean;
}

export default function ChannelSidebar({
  detail,
  activeChannelId,
  onOpenChannel,
  onAddChannel,
  onEditChannel,
  onOpenSettings,
  mapActive = false,
  onOpenMap,
  filesActive = false,
  onOpenFiles,
  onToggleMembers,
  membersOpen,
}: Props) {
  // Сколько участников сейчас на связи (в сети или отошли) — на кнопке «Участники».
  const onlineCount = usePresenceStore(
    (st) => detail.members.filter((m) => st.byId[m.user.id]?.online).length
  );
  const unread = useStarsStore((st) => st.unread);
  const [tempError, setTempError] = useState<string | null>(null);
  // Кто говорит — знаем только на той Планете, где мы сами (голос идёт через нас).
  const voiceChannelId = useVoiceStore((st) => (st.status === "idle" ? null : st.channelId));
  const speakingKey = useVoiceStore((st) =>
    st.peers
      .filter((p) => p.speaking && p.micOn)
      .map((p) => p.userId)
      .join(",")
  );
  const speaking = new Set(speakingKey ? speakingKey.split(",") : []);
  const channels = sortChannels(detail.channels);
  const manage = can(detail, "manage_channels");
  const { bookings, now } = useBookings(detail);
  const notifySettings = useNotifyStore((st) => st.settings);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const starQuiet = starLevel(notifySettings, detail.id) === "none";

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
                    : `Добавить ${placeNouns(detail.kind).acc}`
              }
              aria-label={kind === "satellite" ? "Добавить Спутник" : `Добавить ${placeNouns(detail.kind).acc}`}
            >
              +
            </button>
          )}
        </div>
        {list.map((c) => {
          const count = unread[c.id]?.count ?? 0;
          const mentionCount = unread[c.id]?.mentions ?? 0;
          const quiet = kind === "satellite" && channelLevel(notifySettings, detail.id, c.id) === "none";
          const inside = kind === "planet" ? (detail.voice?.[c.id] ?? []) : [];
          const busy = kind === "planet" ? currentBooking(bookings, c.id, now) : null;
          const sign = kind === "planet" ? doorSign(c, now) : null;
          return (
            <div key={c.id}>
              <button
                type="button"
                className={c.id === activeChannelId && !mapActive && !filesActive ? s.channelActive : s.channel}
                onClick={() => onOpenChannel(c)}
                onDoubleClick={
                  kind === "planet"
                    ? () => void useDoorsStore.getState().enterRoom(detail, c)
                    : manage
                      ? () => onEditChannel(c)
                      : undefined
                }
                title={
                  kind === "planet"
                    ? [
                        busy ? `Занято до ${hhmm(busy.ends_at)}: «${busy.title}»` : "",
                        sign ? `Табличка: ${sign.icon} ${sign.text}` : "",
                        `Двойной клик — ${roomWords(detail.kind, c.name).enter}`,
                      ]
                        .filter(Boolean)
                        .join("\n")
                    : undefined
                }
              >
                {kind === "satellite" ? <IconSatellite /> : <IconPlanet />}
                <span className={`${s.channelName} ${count ? s.channelUnread : ""}`}>
                  {c.room_kind === "lobby" ? "🛋 " : ""}
                  {c.name}
                  {c.room_kind !== "lobby" && c.access === "invite" ? " 🔒" : ""}
                  {c.room_kind !== "lobby" && c.access === "personal" ? " 🔑" : ""}
                  {c.listen_only ? " 🎧" : ""}
                  {c.temporary ? " ⏳" : ""}
                  {c.slow_mode_sec ? " 🐢" : ""}
                  {c.announcement ? " 📢" : ""}
                  {quiet ? " 🔕" : ""}
                  {sign ? ` ${sign.icon}` : ""}
                  {busy ? " 📅" : ""}
                </span>
                {kind === "planet" && (
                  <span className={s.channelHint}>
                    {inside.length ? `${inside.length}/${c.capacity}` : `до ${c.capacity}`}
                  </span>
                )}
                {mentionCount > 0 ? (
                  <span className={s.countBadge} title={`Упоминаний: ${mentionCount}`}>
                    @{mentionCount > 9 ? "9+" : mentionCount}
                  </span>
                ) : (
                  count > 0 && (
                    <span className={quiet ? `${s.countBadge} ${s.countBadgeQuiet}` : s.countBadge}>
                      {count > 99 ? "99+" : count}
                    </span>
                  )
                )}
              </button>
              {inside.length > 0 && (
                <div className={s.presence}>
                  {inside.map((p) => {
                    const name =
                      detail.members.find((m) => m.user.id === p.user_id)?.user.username ?? "Участник";
                    const talking = c.id === voiceChannelId && speaking.has(p.user_id);
                    return (
                      <div key={p.user_id} className={s.presenceRow}>
                        <span
                          className={talking ? `${s.presenceDot} ${s.presenceDotSpeaking}` : s.presenceDot}
                          aria-label={talking ? `${name} говорит` : undefined}
                        >
                          {initials(name)}
                        </span>
                        <span className={s.presenceName}>{name}</span>
                        {p.is_host && c.access === "invite" && c.room_kind !== "lobby" && (
                          <span title="Главный в комнате: впускает и зовёт">👑</span>
                        )}
                        {p.server_muted && <span title="Микрофон выключил модератор">🔇</span>}
                        {p.screen_sharing && <span title="Показывает экран">🖥</span>}
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
            {kind === "satellite" ? "Спутников нет" : `${placeNouns(detail.kind).manyGen} нет`}
          </div>
        )}
        {kind === "planet" && detail.kind === "gaming" && (
          <button
            type="button"
            className={s.channel}
            title="Своя Планета на время: исчезнет, когда все уйдут. В лимит Планет не входит."
            onClick={() =>
              void starsApi
                .temporaryPlanet(detail.id)
                .then((planet) => useDoorsStore.getState().enterRoom(detail, planet))
                .catch((err) => setTempError(apiError(err)))
            }
          >
            <span aria-hidden>＋</span>
            <span className={s.channelName}>Временная Планета</span>
          </button>
        )}
        {kind === "planet" && tempError && (
          <div className={s.error} style={{ padding: "4px 10px" }}>
            {tempError}
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
          className={`${s.iconBtn} ${s.membersBtn} ${membersOpen ? s.membersBtnActive : ""}`}
          onClick={onToggleMembers}
          aria-label={`Участники: ${detail.member_count}, на связи ${onlineCount}`}
          aria-pressed={membersOpen}
          title="Участники и их статусы"
        >
          <IconContacts size={18} />
          {onlineCount > 0 && <span className={s.membersBadge}>{onlineCount}</span>}
        </button>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setNotifyOpen(true)}
          aria-label="Уведомления Звезды"
          title="Уведомления Звезды"
        >
          {starQuiet ? "🔕" : "🔔"}
        </button>
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
        <button
          type="button"
          className={filesActive ? s.channelActive : s.channel}
          style={{ marginTop: 10 }}
          onClick={onOpenFiles}
        >
          <span aria-hidden>📁</span>
          <span className={s.channelName}>Файлы</span>
        </button>
        {detail.kind === "work" && onOpenMap && (
          <button
            type="button"
            className={mapActive ? s.channelActive : s.channel}
            onClick={onOpenMap}
          >
            <span aria-hidden>🗺</span>
            <span className={s.channelName}>Карта офиса</span>
            <span className={s.channelHint}>
              {detail.floors.length > 1 ? `${detail.floors.length} эт.` : ""}
            </span>
          </button>
        )}
        {section("planet", detail.kind === "work" ? "Комнаты" : "Планеты")}
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
      {notifyOpen && (
        <NotifyDialog
          scope="star"
          targetId={detail.id}
          title={`Уведомления: ${detail.name}`}
          inherited={STAR_DEFAULT}
          onClose={() => setNotifyOpen(false)}
        />
      )}
    </div>
  );
}
