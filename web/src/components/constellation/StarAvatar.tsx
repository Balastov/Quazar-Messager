import { useEffect, useState } from "react";
import { initials } from "./rules";
import s from "./Constellation.module.css";

interface Props {
  name: string;
  url: string | null;
}

/** Картинка Звезды, а если её нет или не загрузилась — инициалы. Размер задаёт родитель. */
export default function StarAvatar({ name, url }: Props) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  if (!url || broken) return <>{initials(name)}</>;
  return <img src={url} alt="" className={s.starAvatarImg} onError={() => setBroken(true)} />;
}
