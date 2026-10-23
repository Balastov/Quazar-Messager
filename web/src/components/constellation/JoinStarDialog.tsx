import { useCallback, useEffect, useState } from "react";
import { parseInviteCode, starsApi, type InvitePreview } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { apiError, KIND_LABEL } from "./rules";
import StarAvatar from "./StarAvatar";
import s from "./Constellation.module.css";
import { playStarSound } from "../../sounds/starSounds";

export default function JoinStarDialog() {
  const joinDialog = useStarsStore((st) => st.joinDialog);
  const close = useStarsStore((st) => st.closeJoinDialog);
  const joinByCode = useStarsStore((st) => st.joinByCode);
  const selectStar = useStarsStore((st) => st.selectStar);

  const [input, setInput] = useState(joinDialog?.code ?? "");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (value: string) => {
    const code = parseInviteCode(value);
    setPreview(null);
    setError(null);
    if (!code) {
      setError("Вставьте ссылку-приглашение целиком");
      return;
    }
    setBusy(true);
    try {
      const next = await starsApi.previewInvite(code);
      setPreview(next);
      // Зовут в Звезду — вокзальный «дин-дон-дан».
      if (!next.already_member) void playStarSound("invite");
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // Открыли по ссылке — сразу показываем, куда зовут.
  useEffect(() => {
    if (joinDialog?.code) void check(joinDialog.code);
  }, [joinDialog?.code, check]);

  const join = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      if (preview.already_member) {
        close();
        await selectStar(preview.star_id);
      } else {
        await joinByCode(preview.code);
      }
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Вступить в Звезду" onClose={close}>
      <form
        className={s.list}
        onSubmit={(e) => {
          e.preventDefault();
          void check(input);
        }}
      >
        <label className={s.label}>
          Ссылка-приглашение
          <input
            className={s.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://quazar-msg.ru/invite/…"
            autoFocus={!joinDialog?.code}
            disabled={busy}
          />
        </label>
        {!preview && (
          <button type="submit" className={s.secondary} disabled={busy || !input.trim()}>
            {busy ? "Проверяем…" : "Проверить"}
          </button>
        )}
      </form>

      {preview && (
        <div className={s.listItem}>
          <span className={s.starAvatarBox}>
            <StarAvatar name={preview.star_name} url={preview.star_avatar_url} />
          </span>
          <div className={s.listMain}>
            <span className={s.listTitle}>{preview.star_name}</span>
            <span className={s.listSub}>
              {KIND_LABEL[preview.star_kind]} · участников: {preview.member_count}
            </span>
          </div>
        </div>
      )}
      {preview && (
        <p className={s.hint}>
          Каналы Созвездия не защищены сквозным шифрованием — в отличие от личных чатов.
        </p>
      )}
      {error && <div className={s.error}>{error}</div>}
      {preview && (
        <button type="button" className={s.primary} onClick={() => void join()} disabled={busy}>
          {preview.already_member ? "Открыть Звезду" : busy ? "Вступаем…" : "Вступить"}
        </button>
      )}
    </Dialog>
  );
}
