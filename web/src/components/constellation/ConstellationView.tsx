import { useEffect, useState } from "react";
import type { ChannelKind, StarChannel } from "../../api/stars";
import { useDoorsStore } from "../../store/doors";
import { mentionsForStar, unreadForStar, useStarsStore } from "../../store/stars";
import StarFilesView from "./StarFilesView";
import { IconConstellation } from "../icons";
import ChannelDialog from "./ChannelDialog";
import ChannelSidebar from "./ChannelSidebar";
import CreateStarDialog from "./CreateStarDialog";
import JoinStarDialog from "./JoinStarDialog";
import OfficeMap from "./OfficeMap";
import { useVoiceStore } from "../../store/voice";
import PlanetView, { RoomControls } from "./PlanetView";
import SatelliteView from "./SatelliteView";
import StarSettings, { type SettingsTab } from "./StarSettings";
import StarAvatar from "./StarAvatar";
import s from "./Constellation.module.css";
import MembersPanel from "./MembersPanel";
import ThreadPanel from "./ThreadPanel";
import w from "./Work.module.css";
import { useUiStore } from "../../store/ui";

type ChannelDialogState = { kind: ChannelKind; channel?: StarChannel; floorId?: string } | null;

export default function ConstellationView() {
  const loaded = useStarsStore((st) => st.loaded);
  const stars = useStarsStore((st) => st.stars);
  const details = useStarsStore((st) => st.details);
  const activeStarId = useStarsStore((st) => st.activeStarId);
  const activeChannelByStar = useStarsStore((st) => st.activeChannelByStar);
  const unread = useStarsStore((st) => st.unread);
  const notice = useStarsStore((st) => st.notice);
  const joinDialog = useStarsStore((st) => st.joinDialog);
  const mobileChannelOpen = useStarsStore((st) => st.mobileChannelOpen);
  const threadOpen = useStarsStore((st) => st.thread !== null && st.thread.starId === st.activeStarId);
  const load = useStarsStore((st) => st.load);
  const selectStar = useStarsStore((st) => st.selectStar);
  const selectChannel = useStarsStore((st) => st.selectChannel);
  const setMobileChannelOpen = useStarsStore((st) => st.setMobileChannelOpen);
  const openJoinDialog = useStarsStore((st) => st.openJoinDialog);
  const dismissNotice = useStarsStore((st) => st.dismissNotice);
  const viewByStar = useStarsStore((st) => st.viewByStar);
  const setView = useStarsStore((st) => st.setView);

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  // Участники: на ПК — колонка справа (запоминаем), на телефоне — экран поверх.
  const membersOpen = useUiStore((st) => st.starMembersOpen);
  const setMembersOpen = useUiStore((st) => st.setStarMembersOpen);
  const [mobileMembers, setMobileMembers] = useState(false);
  const isMobile = () => window.matchMedia("(max-width: 767px)").matches;
  const [channelDialog, setChannelDialog] = useState<ChannelDialogState>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (loaded) return;
    load().catch(() => setLoadError(true));
  }, [loaded, load]);

  // Канал на экране — значит прочитан. На телефоне — только когда он открыт поверх списка;
  // открыты карта офиса или «Файлы» — канала не видно.
  const activeView = activeStarId ? viewByStar[activeStarId] : undefined;
  const activeKind = stars.find((st) => st.id === activeStarId)?.kind;
  const channelOnScreen = (activeView ?? (activeKind === "work" ? "map" : "channel")) === "channel";
  useEffect(() => {
    const channelId = activeStarId ? activeChannelByStar[activeStarId] : null;
    if (!channelId || !unread[channelId] || document.visibilityState !== "visible" || !channelOnScreen) return;
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    if (desktop || mobileChannelOpen) void selectChannel(channelId);
  }, [activeStarId, activeChannelByStar, unread, mobileChannelOpen, selectChannel, channelOnScreen]);

  // Стуки в двери этой Звезды (кто может впускать — все, остальным — свои).
  useEffect(() => {
    if (activeStarId) void useDoorsStore.getState().loadKnocks(activeStarId);
  }, [activeStarId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  const detail = activeStarId ? details[activeStarId] : undefined;
  const channelId = activeStarId ? (activeChannelByStar[activeStarId] ?? null) : null;
  const channel = detail?.channels.find((c) => c.id === channelId) ?? null;

  /** У рабочих Звёзд по умолчанию открыта карта офиса. */
  const view = detail ? (viewByStar[detail.id] ?? (detail.kind === "work" ? "map" : "channel")) : "channel";
  const mapOpen = !!detail && detail.kind === "work" && view === "map";
  // Комната этой Звезды, где вы сейчас: её панель остаётся под картой офиса.
  const voiceStarId = useVoiceStore((st) => st.starId);
  const voiceChannelId = useVoiceStore((st) => st.channelId);
  const voiceStatus = useVoiceStore((st) => st.status);
  const myRoom =
    detail && voiceStarId === detail.id && voiceStatus !== "idle"
      ? (detail.channels.find((c) => c.id === voiceChannelId) ?? null)
      : null;
  const filesOpen = !!detail && view === "files";
  const setMapOpen = (open: boolean) => {
    if (detail) setView(detail.id, open ? "map" : "channel");
  };

  const openChannel = (c: StarChannel) => {
    setMapOpen(false);
    void selectChannel(c.id);
    setMobileChannelOpen(true);
  };

  const renderContent = (onBack?: () => void) => {
    if (detail && filesOpen) {
      return <StarFilesView detail={detail} onBack={onBack} onOpenChannel={openChannel} />;
    }
    if (detail && mapOpen) {
      return (
        <>
          <OfficeMap
            detail={detail}
            onBack={onBack}
            onOpenPlanet={openChannel}
            onAddRoom={(floorId) => setChannelDialog({ kind: "planet", floorId })}
          />
          {myRoom && <RoomControls detail={detail} channel={myRoom} />}
        </>
      );
    }
    if (!detail || !channel) {
      return (
        <div className={s.empty}>
          {detail
            ? `Выберите Спутник или ${detail.kind === "work" ? "Комнату" : "Планету"} слева`
            : "Загрузка…"}
        </div>
      );
    }
    return channel.kind === "satellite" ? (
      <SatelliteView
        detail={detail}
        channel={channel}
        onBack={onBack}
        onEdit={() => setChannelDialog({ kind: "satellite", channel })}
      />
    ) : (
      <PlanetView
        detail={detail}
        channel={channel}
        onBack={onBack}
        onEdit={() => setChannelDialog({ kind: "planet", channel })}
      />
    );
  };

  return (
    <div className={s.root}>
      <nav className={s.rail} aria-label="Звёзды">
        {stars.map((star) => {
          const count = unreadForStar(unread, star.id);
          const mentions = mentionsForStar(unread, star.id);
          const active = star.id === activeStarId;
          return (
            <button
              key={star.id}
              type="button"
              className={`${active ? s.railStarActive : s.railStar} ${star.kind === "work" ? s.railStarWork : ""}`}
              onClick={() => {
                void selectStar(star.id);
                setMobileChannelOpen(false);
              }}
              title={star.name}
              aria-label={star.name}
              aria-current={active}
            >
              <StarAvatar name={star.name} url={star.avatar_url} />
              {count > 0 && (
                <span className={s.badge} title={mentions ? `Упоминаний: ${mentions}` : undefined}>
                  {mentions ? `@${mentions > 9 ? "9+" : mentions}` : count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          );
        })}
        {stars.length > 0 && <div className={s.railDivider} />}
        <button
          type="button"
          className={s.railAction}
          onClick={() => setCreateOpen(true)}
          title="Создать Звезду"
          aria-label="Создать Звезду"
        >
          +
        </button>
        <button
          type="button"
          className={s.railAction}
          onClick={() => openJoinDialog()}
          title="Вступить по приглашению"
          aria-label="Вступить по приглашению"
          style={{ fontSize: 18 }}
        >
          ↪
        </button>
      </nav>

      {loaded && stars.length === 0 ? (
        <div className={s.sidebar} style={{ flex: 1 }}>
          <div className={s.empty}>
            <IconConstellation size={48} />
            <div className={s.emptyTitle} style={{ marginTop: 12 }}>
              Созвездие
            </div>
            <p className={s.hint} style={{ marginBottom: 16 }}>
              Звёзды — это общие пространства для компании или команды: текстовые Спутники,
              голосовые Планеты в игровых Звёздах и Комнаты в рабочих. Создайте свою или вступите
              по ссылке-приглашению.
            </p>
            <div className={s.list}>
              <button type="button" className={s.primary} onClick={() => setCreateOpen(true)}>
                Создать Звезду
              </button>
              <button type="button" className={s.secondary} onClick={() => openJoinDialog()}>
                У меня есть приглашение
              </button>
            </div>
          </div>
        </div>
      ) : detail ? (
        <>
          <ChannelSidebar
            detail={detail}
            activeChannelId={channelId}
            mapActive={mapOpen}
            filesActive={filesOpen}
            onOpenMap={() => {
              setMapOpen(true);
              setMobileChannelOpen(true);
            }}
            onOpenFiles={() => {
              setView(detail.id, "files");
              setMobileChannelOpen(true);
            }}
            onOpenChannel={openChannel}
            onAddChannel={(kind) => setChannelDialog({ kind })}
            onAddRoom={(floorId) => setChannelDialog({ kind: "planet", floorId })}
            onEditChannel={(c) => setChannelDialog({ kind: c.kind, channel: c })}
            onOpenSettings={(tab) => setSettingsTab(tab ?? "general")}
            membersOpen={membersOpen}
            onToggleMembers={() => (isMobile() ? setMobileMembers(true) : setMembersOpen(!membersOpen))}
          />
          <section className={s.content}>{renderContent()}</section>
          {threadOpen && (
            <div className={w.threadColumn}>
              <ThreadPanel detail={detail} />
            </div>
          )}
          {membersOpen && !threadOpen && (
            <div className={s.membersColumn}>
              <MembersPanel detail={detail} onClose={() => setMembersOpen(false)} />
            </div>
          )}
          {mobileChannelOpen && (
            <section className={s.mobileContent}>
              {renderContent(() => setMobileChannelOpen(false))}
            </section>
          )}
          {/* После экрана канала — чтобы оказаться поверх него. */}
          {threadOpen && (
            <section className={s.mobileContent}>
              <ThreadPanel detail={detail} fullscreen />
            </section>
          )}
          {mobileMembers && (
            <section className={s.mobileContent}>
              <MembersPanel detail={detail} onClose={() => setMobileMembers(false)} fullscreen />
            </section>
          )}
        </>
      ) : (
        <div className={s.sidebar} style={{ flex: 1 }}>
          <div className={s.empty}>
            {loadError ? (
              <>
                Не удалось загрузить Созвездие.{" "}
                <button
                  type="button"
                  className={`${s.secondary} ${s.small}`}
                  onClick={() => {
                    setLoadError(false);
                    load().catch(() => setLoadError(true));
                  }}
                >
                  Повторить
                </button>
              </>
            ) : (
              "Загрузка…"
            )}
          </div>
        </div>
      )}

      {createOpen && <CreateStarDialog onClose={() => setCreateOpen(false)} />}
      {joinDialog && <JoinStarDialog key={joinDialog.code} />}
      {detail && settingsTab && (
        <StarSettings
          detail={detail}
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
        />
      )}
      {detail && channelDialog && (
        <ChannelDialog
          starKind={detail.kind}
          kind={channelDialog.kind}
          channel={channelDialog.channel}
          floors={detail.floors}
          defaultFloorId={channelDialog.floorId}
          canEditMap={detail.my_permissions.includes("edit_map")}
          members={detail.members}
          onClose={() => setChannelDialog(null)}
        />
      )}
      {notice && (
        <div className={s.notice} role="status">
          <span className={s.noticeText}>{notice}</span>
          <button type="button" className={s.close} onClick={dismissNotice} aria-label="Закрыть">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
