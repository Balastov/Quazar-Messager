import { canOpenSms, shareInvite, smsHref } from "./invite";
import { IconStarInvite } from "../components/icons";

interface Props {
  className?: string;
  /** Короткое пояснение после копирования («Приглашение скопировано…»). */
  onNotice?: (text: string) => void;
  /** Метка для обучения (подсветка кнопки). */
  tour?: string;
}

/** «Пригласить друзей»: на телефоне — SMS с текстом и ссылкой, на компьютере — поделиться или скопировать. */
export default function InviteFriendsButton({ className, onNotice, tour }: Props) {
  const content = (
    <>
      <IconStarInvite size={16} />
      <span>Пригласить друзей</span>
    </>
  );
  if (canOpenSms()) {
    return (
      <a className={className} href={smsHref()} data-tour={tour}>
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      data-tour={tour}
      onClick={async () => {
        const result = await shareInvite();
        if (result === "copied") onNotice?.("Приглашение скопировано — отправьте его другу");
      }}
    >
      {content}
    </button>
  );
}
