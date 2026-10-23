import { useCallback, useEffect, useRef, useState } from "react";
import {
  inviteLink,
  starsApi,
  type RolePermissions,
  type StarBan,
  type StarDetail,
  type StarInvite,
  type StarPerm,
} from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import UserAvatar from "../UserAvatar";
import { squareAvatar } from "../../utils/squareAvatar";
import Dialog from "./Dialog";
import StarAvatar from "./StarAvatar";
import {
  apiError,
  assignableRoles,
  can,
  canBan,
  canKick,
  KIND_LABEL,
  MEMBER_GRANTABLE,
  permLabel,
  PERM_ORDER,
  ROLE_LABEL,
} from "./rules";
import s from "./Constellation.module.css";
import { usePresenceText } from "../../store/presence";

export type SettingsTab = "general" | "members" | "invites" | "permissions" | "bans" | "star";

interface Props {
  detail: StarDetail;
  initialTab?: SettingsTab;
  onClose: () => void;
}

export default function StarSettings({ detail, initialTab = "general", onClose }: Props) {
  const isOwner = detail.my_role === "owner";
  const isAdmin = isOwner || detail.my_role === "admin";

  const tabs: { id: SettingsTab; label: string; show: boolean }[] = [
    { id: "general", label: "Общее", show: true },
    { id: "members", label: `Участники · ${detail.member_count}`, show: true },
    { id: "invites", label: "Приглашения", show: can(detail, "invite") },
    { id: "permissions", label: "Права", show: isOwner },
    { id: "bans", label: "Блокировки", show: isAdmin },
    { id: "star", label: "Звезда", show: isOwner },
  ];
  const visible = tabs.filter((t) => t.show);
  const [tab, setTab] = useState<SettingsTab>(
    visible.some((t) => t.id === initialTab) ? initialTab : "general"
  );

  return (
    <Dialog title={detail.name} onClose={onClose} wide>
      <div className={s.tabs} role="tablist">
        {visible.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? s.tabActive : s.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "general" && <GeneralTab detail={detail} onClose={onClose} />}
      {tab === "members" && <MembersTab detail={detail} />}
      {tab === "invites" && <InvitesTab detail={detail} />}
      {tab === "permissions" && <PermissionsTab detail={detail} />}
      {tab === "bans" && <BansTab detail={detail} />}
      {tab === "star" && <StarTab detail={detail} onClose={onClose} />}
    </Dialog>
  );
}

/** Выполняет действие и показывает ошибку или итог. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>, doneText?: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      if (doneText) setDone(doneText);
      return true;
    } catch (err) {
      setError(apiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const status = (
    <>
      {error && <div className={s.error}>{error}</div>}
      {done && <div className={s.ok}>{done}</div>}
    </>
  );
  return { busy, run, status };
}

function GeneralTab({ detail, onClose }: { detail: StarDetail; onClose: () => void }) {
  const renameStar = useStarsStore((st) => st.renameStar);
  const setStarAvatar = useStarsStore((st) => st.setStarAvatar);
  const leaveStar = useStarsStore((st) => st.leaveStar);
  const fileRef = useRef<HTMLInputElement>(null);
  const limits = useStarsStore((st) => st.limits);
  const [name, setName] = useState(detail.name);
  const { busy, run, status } = useAction();
  const canRename = detail.my_role === "owner" || detail.my_role === "admin";

  return (
    <div className={s.list}>
      <p className={s.hint}>
        {KIND_LABEL[detail.kind]} · участников: {detail.member_count}
        {limits ? ` из ${limits.max_star_members}` : ""} · ваша роль:{" "}
        {ROLE_LABEL[detail.my_role]}
      </p>
      <p className={s.hint}>
        Каналы Созвездия не защищены сквозным шифрованием — в отличие от личных чатов.
      </p>

      {canRename && (
        <div className={s.row}>
          <span className={s.starAvatarLarge}>
            <StarAvatar name={detail.name} url={detail.avatar_url} />
          </span>
          <div className={s.listMain}>
            <span className={s.listTitle}>Аватар Звезды</span>
            <span className={s.listSub}>Квадрат по центру картинки. JPEG, PNG, WebP или GIF.</span>
          </div>
          <button
            type="button"
            className={s.secondary}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {detail.avatar_url ? "Заменить" : "Загрузить"}
          </button>
          {detail.avatar_url && (
            <button
              type="button"
              className={s.danger}
              disabled={busy}
              onClick={() => void run(() => setStarAvatar(null), "Аватар убран")}
            >
              Убрать
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) {
                void run(async () => setStarAvatar(await squareAvatar(file)), "Аватар обновлён");
              }
            }}
          />
        </div>
      )}

      {canRename && (
        <form
          className={s.row}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void run(() => renameStar(name.trim()), "Название сохранено");
          }}
        >
          <input
            className={s.input}
            style={{ flex: 1, minWidth: 180 }}
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            aria-label="Название Звезды"
          />
          <button
            type="submit"
            className={s.secondary}
            disabled={busy || !name.trim() || name.trim() === detail.name}
          >
            Переименовать
          </button>
        </form>
      )}

      {detail.my_role !== "owner" && (
        <button
          type="button"
          className={s.danger}
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Выйти из Звезды «${detail.name}»?`)) {
              void run(async () => {
                await leaveStar();
                onClose();
              });
            }
          }}
        >
          Выйти из Звезды
        </button>
      )}
      {status}
    </div>
  );
}

function MembersTab({ detail }: { detail: StarDetail }) {
  const myId = useAuthStore((st) => st.user?.id);
  const setRole = useStarsStore((st) => st.setRole);
  const kick = useStarsStore((st) => st.kick);
  const ban = useStarsStore((st) => st.ban);
  const { busy, run, status } = useAction();

  return (
    <div className={s.list}>
      {detail.members.map((m) => {
        const isMe = m.user.id === myId;
        const roles = isMe ? [] : assignableRoles(detail.my_role, m.role);
        const kickable = !isMe && canKick(detail, m.role);
        const bannable = !isMe && canBan(detail.my_role, m.role);
        return (
          <div key={m.user.id} className={s.listItem}>
            <UserAvatar username={m.user.username} avatarUrl={m.user.avatar_url} size="sm" userId={m.user.id} />
            <div className={s.listMain}>
              <span className={s.listTitle}>
                {m.user.username}
                {isMe ? " (вы)" : ""}
              </span>
              <span className={s.listSub}>
                {ROLE_LABEL[m.role]}
                <MemberStatus userId={m.user.id} />
              </span>
            </div>
            {roles.length > 0 && (
              <select
                className={s.select}
                style={{ width: "auto" }}
                value=""
                disabled={busy}
                aria-label={`Роль ${m.user.username}`}
                onChange={(e) => {
                  const role = e.target.value as (typeof roles)[number];
                  if (role) void run(() => setRole(m.user.id, role));
                }}
              >
                <option value="">Сменить роль…</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            )}
            {kickable && (
              <button
                type="button"
                className={`${s.secondary} ${s.small}`}
                disabled={busy}
                title="Убрать из Звезды. Сможет вернуться по новому приглашению."
                onClick={() => {
                  if (window.confirm(`Выгнать ${m.user.username}? Вернуться можно по новому приглашению.`)) {
                    void run(() => kick(m.user.id));
                  }
                }}
              >
                Выгнать
              </button>
            )}
            {bannable && (
              <button
                type="button"
                className={`${s.danger} ${s.small}`}
                disabled={busy}
                title="Убрать и не пускать обратно, пока не снимете блокировку."
                onClick={() => {
                  if (
                    window.confirm(
                      `Заблокировать ${m.user.username}? Вернуться нельзя, пока блокировку не снимут.`
                    )
                  ) {
                    void run(() => ban(m.user.id));
                  }
                }}
              >
                Заблокировать
              </button>
            )}
          </div>
        );
      })}
      {status}
    </div>
  );
}

const EXPIRY_OPTIONS = [
  { label: "Без срока", hours: undefined },
  { label: "1 день", hours: 24 },
  { label: "7 дней", hours: 24 * 7 },
];
const USES_OPTIONS = [
  { label: "Без ограничений", uses: undefined },
  { label: "1 человек", uses: 1 },
  { label: "10 человек", uses: 10 },
];

function InvitesTab({ detail }: { detail: StarDetail }) {
  const myId = useAuthStore((st) => st.user?.id);
  const [invites, setInvites] = useState<StarInvite[] | null>(null);
  const [expiry, setExpiry] = useState(0);
  const [uses, setUses] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const { busy, run, status } = useAction();
  const isAdmin = detail.my_role === "owner" || detail.my_role === "admin";

  const reload = useCallback(async () => {
    setInvites(await starsApi.invites(detail.id));
  }, [detail.id]);

  useEffect(() => {
    void run(reload);
  }, [run, reload]);

  const copy = async (code: string) => {
    const link = inviteLink(code);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(code);
    } catch {
      window.prompt("Скопируйте ссылку:", link);
    }
  };

  return (
    <div className={s.list}>
      <p className={s.hint}>
        Отправьте ссылку человеку — по ней он вступит в Звезду. В Звезде может быть до 50
        участников.
      </p>
      <div className={s.row}>
        <select
          className={s.select}
          style={{ width: "auto" }}
          value={expiry}
          onChange={(e) => setExpiry(Number(e.target.value))}
          aria-label="Срок действия"
        >
          {EXPIRY_OPTIONS.map((o, i) => (
            <option key={o.label} value={i}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className={s.select}
          style={{ width: "auto" }}
          value={uses}
          onChange={(e) => setUses(Number(e.target.value))}
          aria-label="Сколько раз можно использовать"
        >
          {USES_OPTIONS.map((o, i) => (
            <option key={o.label} value={i}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={s.primary}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const invite = await starsApi.createInvite(detail.id, {
                expires_in_hours: EXPIRY_OPTIONS[expiry].hours,
                max_uses: USES_OPTIONS[uses].uses,
              });
              await reload();
              await copy(invite.code);
            })
          }
        >
          Создать ссылку
        </button>
      </div>

      {invites?.map((inv) => (
        <div key={inv.code} className={s.listItem}>
          <div className={s.listMain}>
            <span className={`${s.listTitle} ${s.code}`}>{inviteLink(inv.code)}</span>
            <span className={s.listSub}>
              {inv.expires_at
                ? `до ${new Date(inv.expires_at).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                : "без срока"}
              {" · "}
              {inv.max_uses ? `использовано ${inv.uses} из ${inv.max_uses}` : `использовано ${inv.uses}`}
            </span>
          </div>
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => void copy(inv.code)}>
            {copied === inv.code ? "Скопировано ✓" : "Копировать"}
          </button>
          {(isAdmin || inv.created_by === myId) && (
            <button
              type="button"
              className={`${s.danger} ${s.small}`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await starsApi.revokeInvite(detail.id, inv.code);
                  await reload();
                })
              }
            >
              Отозвать
            </button>
          )}
        </div>
      ))}
      {invites?.length === 0 && <p className={s.hint}>Активных ссылок нет.</p>}
      {status}
    </div>
  );
}

function PermissionsTab({ detail }: { detail: StarDetail }) {
  const setPermissions = useStarsStore((st) => st.setPermissions);
  const [perms, setPerms] = useState<RolePermissions>(detail.role_permissions);
  const { busy, run, status } = useAction();

  const toggle = (role: keyof RolePermissions, perm: StarPerm) => {
    setPerms((p) => ({
      ...p,
      [role]: p[role].includes(perm) ? p[role].filter((x) => x !== perm) : [...p[role], perm],
    }));
  };

  const changed =
    JSON.stringify([...perms.moderator].sort()) !==
      JSON.stringify([...detail.role_permissions.moderator].sort()) ||
    JSON.stringify([...perms.member].sort()) !==
      JSON.stringify([...detail.role_permissions.member].sort());

  return (
    <div className={s.list}>
      <p className={s.hint}>
        Владелец и админы могут всё. Блокировать участников и назначать модераторов могут только
        владелец и админы, назначать админов — только владелец.
      </p>
      <table className={s.permTable}>
        <thead>
          <tr>
            <th>Право</th>
            <th>Админ</th>
            <th>Модератор</th>
            <th>Участник</th>
          </tr>
        </thead>
        <tbody>
          {PERM_ORDER.map((perm) => (
            <tr key={perm}>
              <td>{permLabel(perm, detail.kind)}</td>
              <td>
                <input type="checkbox" checked disabled aria-label={`Админ: ${permLabel(perm, detail.kind)}`} />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={perms.moderator.includes(perm)}
                  onChange={() => toggle("moderator", perm)}
                  disabled={busy}
                  aria-label={`Модератор: ${permLabel(perm, detail.kind)}`}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={perms.member.includes(perm)}
                  onChange={() => toggle("member", perm)}
                  disabled={busy || !MEMBER_GRANTABLE.includes(perm)}
                  aria-label={`Участник: ${permLabel(perm, detail.kind)}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className={s.primary}
        disabled={busy || !changed}
        onClick={() => void run(() => setPermissions(perms), "Права сохранены")}
      >
        Сохранить права
      </button>
      {status}
    </div>
  );
}

function BansTab({ detail }: { detail: StarDetail }) {
  const [bans, setBans] = useState<StarBan[] | null>(null);
  const { busy, run, status } = useAction();

  const reload = useCallback(async () => {
    setBans(await starsApi.bans(detail.id));
  }, [detail.id]);

  useEffect(() => {
    void run(reload);
  }, [run, reload]);

  return (
    <div className={s.list}>
      <p className={s.hint}>
        Заблокированные не могут вступить в Звезду даже по новому приглашению.
      </p>
      {bans?.map((b) => (
        <div key={b.user.id} className={s.listItem}>
          <UserAvatar username={b.user.username} avatarUrl={b.user.avatar_url} size="sm" />
          <div className={s.listMain}>
            <span className={s.listTitle}>{b.user.username}</span>
            <span className={s.listSub}>
              с {new Date(b.created_at).toLocaleDateString("ru", { day: "numeric", month: "long" })}
            </span>
          </div>
          <button
            type="button"
            className={`${s.secondary} ${s.small}`}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await starsApi.unban(detail.id, b.user.id);
                await reload();
              }, `Блокировка ${b.user.username} снята`)
            }
          >
            Разблокировать
          </button>
        </div>
      ))}
      {bans?.length === 0 && <p className={s.hint}>Никто не заблокирован.</p>}
      {status}
    </div>
  );
}

function StarTab({ detail, onClose }: { detail: StarDetail; onClose: () => void }) {
  const transferStar = useStarsStore((st) => st.transferStar);
  const deleteStar = useStarsStore((st) => st.deleteStar);
  const [target, setTarget] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const { busy, run, status } = useAction();
  const candidates = detail.members.filter((m) => m.role !== "owner");

  return (
    <div className={s.list}>
      <h4 className={s.dialogTitle} style={{ fontSize: 15 }}>
        Передать Звезду
      </h4>
      <p className={s.hint}>
        Новый владелец получит все права, а вы станете админом и освободите место для своей
        Звезды. Передать можно только тому, у кого меньше двух своих Звёзд.
      </p>
      <div className={s.row}>
        <select
          className={s.select}
          style={{ flex: 1, minWidth: 180 }}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy || candidates.length === 0}
          aria-label="Кому передать"
        >
          <option value="">{candidates.length ? "Выберите участника…" : "Некому передать"}</option>
          {candidates.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.username} · {ROLE_LABEL[m.role]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={s.secondary}
          disabled={busy || !target}
          onClick={() => {
            const name = candidates.find((m) => m.user.id === target)?.user.username;
            if (window.confirm(`Передать Звезду «${detail.name}» пользователю ${name}?`)) {
              void run(() => transferStar(target), "Звезда передана");
            }
          }}
        >
          Передать
        </button>
      </div>

      <h4 className={s.dialogTitle} style={{ fontSize: 15, marginTop: 8 }}>
        Удалить Звезду
      </h4>
      <p className={s.hint}>
        Все Спутники с перепиской и {detail.kind === "work" ? "Комнаты" : "Планеты"} исчезнут для
        всех участников. Отменить нельзя. Чтобы
        подтвердить, введите название Звезды.
      </p>
      <input
        className={s.input}
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={detail.name}
        disabled={busy}
        aria-label="Название Звезды для подтверждения"
      />
      <button
        type="button"
        className={s.danger}
        disabled={busy || confirmName.trim() !== detail.name}
        onClick={() =>
          void run(async () => {
            await deleteStar();
            onClose();
          })
        }
      >
        Удалить навсегда
      </button>
      {status}
    </div>
  );
}

/** « · в сети», « · был(а) вчера в 21:40» — после роли. */
function MemberStatus({ userId }: { userId: string }) {
  const text = usePresenceText(userId);
  return text ? <> · {text}</> : null;
}
