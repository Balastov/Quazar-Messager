import { createPortal } from "react-dom";
import Dialog from "../constellation/Dialog";
import base from "../SettingsView.module.css";

/** «Купить» пока только объясняет: покупки ещё нет. */
export default function BuyPremiumDialog({ trialAvailable, onTrial, onClose }: {
  trialAvailable: boolean; onTrial?(): void; onClose(): void;
}) {
  return createPortal(
    <Dialog title="Quazar Premium" onClose={onClose}>
      <p className={base.hint} role="status">
        Quazar Premium пока в ранней разработке — купить его сейчас нельзя. Мы напишем в чате
        Quazar_news_bot, когда покупка появится.
      </p>
      {trialAvailable && <p className={base.hint}>А пока можно бесплатно попробовать Premium целый месяц.</p>}
      <div className={base.rowBtns}>
        {trialAvailable && onTrial && (
          <button type="button" className={base.primary} onClick={() => { onClose(); onTrial(); }}>
            Попробовать бесплатно
          </button>
        )}
        <button type="button" className={base.secondary} onClick={onClose}>
          Понятно
        </button>
      </div>
    </Dialog>,
    document.body
  );
}
