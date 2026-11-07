import s from "./Messages.module.css";
export default function DraftNotice({ error, text }: { error: boolean; text: string }) {
  return error ? <div className={s.context} role="status">Не удалось восстановить или сохранить черновик на устройстве. {text && "Скопируйте текст перед закрытием. "}Проверьте, разрешено ли локальное хранилище.</div> : null;
}
