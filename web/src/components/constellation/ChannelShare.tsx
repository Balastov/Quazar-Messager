import { useState } from "react";
import { starsApi, type SharedStar, type StarChannel } from "../../api/stars";
import { formatWhen } from "../../chat/when";
import { apiError } from "./rules";
import s from "./Constellation.module.css";

/**
 * Настройки Спутника у хозяина: выпустить код для другой Звезды и отключить подключённые.
 * Код одноразовый и действует 7 дней; ввести его может админ другой Звезды.
 */
export function ShareSection({ starId, channel }: { starId: string; channel: StarChannel }) {
  const [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guests = channel.shared_with ?? [];

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await starsApi.createShareInvite(starId, channel.id));
      setCopied(false);
    } catch (err) {
      setError(apiError(err, "Не удалось выпустить код"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (guest: SharedStar) => {
    if (!window.confirm(`Отключить «${guest.name}» от Спутника? Её участники перестанут видеть его и писать в него.`)) return;
    setBusy(true);
    setError(null);
    try {
      await starsApi.removeShare(starId, channel.id, guest.id);
    } catch (err) {
      setError(apiError(err, "Не удалось отключить"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.label}>
      🔗 Общий Спутник
      <span className={s.hint}>
        Другая Звезда (например, партнёр или подрядчик) увидит этот Спутник у себя и сможет писать в него. Остальные
        ваши каналы, участники и настройки ей не видны. Настройки, закрепы и модерация остаются у вас.
      </span>
      {guests.map((g) => (
        <div key={g.id} className={s.row}>
          <span style={{ flex: 1 }}>«{g.name}»</span>
          <button type="button" className={`${s.danger} ${s.small}`} disabled={busy} onClick={() => void remove(g)}>
            Отключить
          </button>
        </div>
      ))}
      {invite ? (
        <div className={s.row}>
          <code style={{ flex: 1, overflowWrap: "anywhere", fontSize: 13 }}>{invite.code}</code>
          <button
            type="button"
            className={`${s.secondary} ${s.small}`}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(invite.code)
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            {copied ? "Скопировано" : "Копировать"}
          </button>
        </div>
      ) : (
        <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy} onClick={() => void issue()}>
          Пригласить другую Звезду…
        </button>
      )}
      {invite && (
        <span className={s.hint}>
          Передайте код админу другой Звезды: у себя он нажмёт «+» у Спутников и введёт код внизу окна. Код одноразовый, действует до{" "}
          {formatWhen(invite.expires_at)}.
        </span>
      )}
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}

/** Подключить общий Спутник другой Звезды по коду (в окне «Новый Спутник»). */
export function ConnectShared({ starId, onDone }: { starId: string; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<{ channel_name: string; star: SharedStar } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await starsApi.previewShareInvite(code.trim()));
    } catch (err) {
      setPreview(null);
      setError(apiError(err, "Код не подошёл"));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await starsApi.acceptShareInvite(code.trim(), starId);
      onDone();
    } catch (err) {
      setError(apiError(err, "Не удалось подключить"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.label}>
      🔗 Есть код общего Спутника от другой Звезды?
      <div className={s.row}>
        <input
          className={s.input}
          style={{ flex: 1 }}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setPreview(null);
          }}
          placeholder="Код приглашения"
          aria-label="Код общего Спутника"
        />
        {!preview && (
          <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy || !code.trim()} onClick={() => void check()}>
            Проверить
          </button>
        )}
      </div>
      {preview && (
        <div className={s.row}>
          <span style={{ flex: 1 }}>
            Спутник «{preview.channel_name}» Звезды «{preview.star.name}»
          </span>
          <button type="button" className={`${s.primary} ${s.small}`} disabled={busy} onClick={() => void accept()}>
            Подключить
          </button>
        </div>
      )}
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}
