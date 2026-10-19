import { useEffect, useState } from "react";
import type { ChannelKind, StarChannel } from "../../api/stars";
import { useDoorsStore } from "../../store/doors";
import { unreadForStar, useStarsStore } from "../../store/stars";
import { IconConstellation } from "../icons";
import ChannelDialog from "./ChannelDialog";
import ChannelSidebar from "./ChannelSidebar";
import CreateStarDialog from "./CreateStarDialog";
import JoinStarDialog from "./JoinStarDialog";
import OfficeMap from "./OfficeMap";
import PlanetView from "./PlanetView";
import SatelliteView from "./SatelliteView";
import StarSettings, { type SettingsTab } from "./StarSettings";
import { initials } from "./rules";
import s from "./Constellation.module.css";

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
  const load = useStarsStore((st) => st.load);
  const selectStar = useStarsStore((st) => st.selectStar);
  const selectChannel = useStarsStore((st) => st.selectChannel);
  const setMobileChannelOpen = useStarsStore((st) => st.setMobileChannelOpen);
  const openJoinDialog = useStarsStore((st) => st.openJoinDialog);
  const dismissNotice = useStarsStore((st) => st.dismissNotice);

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [channelDialog, setChannelDialog] = useState<ChannelDialogState>(null);
  const [loadError, setLoadError] = useState(false);
  /** У рабочих Звёзд по умолчанию открыта карта офиса. */
  const [mapByStar, setMapByStar] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (loaded) return;
    load().catch(() => setLoadError(true));
  }, [loaded, load]);

  // Канал на экране — значит прочитан. На телефоне — только когда он открыт поверх списка.
  useEffect(() => {
    const channelId = activeStarId ? activeChannelByStar[activeStarId] : null;
    if (!channelId || !unread[channelId] || document.visibilityState !== "visible") return;
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    if (desktop || mobileChannelOpen) void selectChannel(channelId);
  }, [activeStarId, activeChannelByStar, unread, mobileChannelOpen, selectChannel]);

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

  const mapOpen = !!detail && detail.kind === "work" && (mapByStar[detail.id] ?? true);
  const setMapOpen = (open: boolean) => {
    if (detail) setMapByStar((m) => ({ ...m, [detail.id]: open }));
  };

  const openChannel = (c: StarChannel) => {
    setMapOpen(false);
    void selectChannel(c.id);
    setMobileChannelOpen(true);
  };

  const renderContent = (onBack?: () => void) => {
    if (detail && mapOpen) {
      return (
        <OfficeMap
          detail={detail}
          onBack={onBack}
          onOpenPlanet={openChannel}
          onAddRoom={(floorId) => setChannelDialog({ kind: "planet", floorId })}
        />
      );
    }
    if (!detail || !channel) {
      return (
        <div className={s.empty}>
          {detail ? "Выберите Спутник или Планету слева" : "Загрузка…"}
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
              {initials(star.name)}
              {count > 0 && <span className={s.badge}>{count > 99 ? "99+" : count}</span>}
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
              Звёзды — это общие пространства для компании или команды: текстовые Спутники и
              голосовые Планеты. Создайте свою или вступите по ссылке-приглашению.
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
            onOpenMap={() => {
              setMapOpen(true);
              setMobileChannelOpen(true);
            }}
            onOpenChannel={openChannel}
            onAddChannel={(kind) => setChannelDialog({ kind })}
            onEditChannel={(c) => setChannelDialog({ kind: c.kind, channel: c })}
            onOpenSettings={(tab) => setSettingsTab(tab ?? "general")}
          />
          <section className={s.content}>{renderContent()}</section>
          {mobileChannelOpen && (
            <section className={s.mobileContent}>
              {renderContent(() => setMobileChannelOpen(false))}
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
