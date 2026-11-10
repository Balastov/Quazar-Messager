import { useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert } from "lucide-react";
import { useE2EStore } from "../../store/e2e";
import Dialog from "../constellation/Dialog";
import KeyHelp from "./KeyHelp";
import s from "./Settings.module.css";
import base from "../SettingsView.module.css";

/** Справка о ключах в отдельном окне; из неё можно сразу перейти к восстановлению. */
export function KeyHelpDialog({ onClose }: { onClose(): void }) {
  const missing = useE2EStore((st) => st.status === "needs_restore");
  return createPortal(
    <Dialog title="Ключи шифрования" onClose={onClose} wide>
      <KeyHelp
        onRestore={
          missing
            ? () => {
                onClose();
                useE2EStore.getState().setRestorePromptOpen(true);
              }
            : undefined
        }
      />
    </Dialog>,
    document.body
  );
}

export function KeyHelpButton({ label = "Что с этим делать?", className }: { label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className ?? base.secondary} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && <KeyHelpDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** Ключа аккаунта на этом устройстве нет: видно в любом разделе настроек. */
export default function KeyWarning() {
  const missing = useE2EStore((st) => st.status === "needs_restore");
  if (!missing) return null;
  return (
    <section className={s.keyWarning} role="alert" aria-label="Нет ключей шифрования">
      <ShieldAlert size={22} className={s.keyWarningIcon} aria-hidden />
      <div className={s.keyWarningBody}>
        <div className={s.keyWarningTitle}>На этом устройстве нет ключей шифрования</div>
        <p className={base.hint}>
          Личные сообщения здесь не открываются и не отправляются. Остальное работает как обычно.
        </p>
        <div className={base.rowBtns}>
          <button
            type="button"
            className={base.primary}
            onClick={() => useE2EStore.getState().setRestorePromptOpen(true)}
          >
            Восстановить ключи
          </button>
          <KeyHelpButton />
        </div>
      </div>
    </section>
  );
}
