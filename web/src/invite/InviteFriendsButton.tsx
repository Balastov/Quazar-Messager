import { canOpenSms, shareInvite, smsHref } from "./invite";
import { IconStarInvite } from "../components/icons";

interface Props {
  className?: string;
  /** Короткое пояснение после копирования («Приглашение скопировано…»). */
  onNotice?: (text: string) => void;
}

/** «Пригласить друзей»: на телефоне — SMS с текстом и ссылкой, на компьютере — поделиться или скопировать. */
export default function InviteFriendsButton({ className, onNotice }: Props) {
  const content = (
    <>
      <IconStarInvite size={16} />
      <span>Пригласить друзей</span>
    </>
  );
  if (canOpenSms()) {
    return (
      <a className={className} href={smsHref()}>
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const result = await shareInvite();
        if (result === "copied") onNotice?.("Приглашение скопировано — отправьте его другу");
      }}
    >
      {content}
    </button>
  );
}
