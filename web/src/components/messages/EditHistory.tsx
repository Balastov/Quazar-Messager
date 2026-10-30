import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { wordDiff } from "../../chat/diff";
import { formatWhen } from "../../chat/when";
import Dialog from "../constellation/Dialog";
import f from "./EditHistory.module.css";

export interface Version {
  text: string;
  at: string;
}

/**
 * История правок сообщения: версии от новой к старой, у каждой — что поменялось по сравнению
 * с предыдущей (добавленное зелёным, убранное зачёркнуто).
 */
export default function EditHistory({
  current,
  load,
  onClose,
}: {
  /** Текущая версия (из самого сообщения). */
  current: Version;
  /** Прежние версии, старые первыми. */
  load: () => Promise<Version[]>;
  onClose: () => void;
}) {
  const [older, setOlder] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load()
      .then(setOlder)
      .catch(() => setError("Не удалось загрузить историю правок"));
    // load меняется на каждом рендере родителя — грузим один раз на открытие.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const versions = useMemo(() => (older ? [...older, current] : null), [older, current]);

  // В body: стеклянные панели (backdrop-filter) иначе обрежут окно и перехватят клики.
  return createPortal(
    <Dialog title="История правок" onClose={onClose}>
      {error && <div className={f.error}>{error}</div>}
      {!versions && !error && <div className={f.empty}>Загрузка…</div>}
      {versions && versions.length === 1 && (
        <div className={f.empty}>Прежние версии не сохранились — их хранят с этого обновления.</div>
      )}
      <ol className={f.list}>
        {versions
          ?.map((v, i) => ({ v, i }))
          .reverse()
          .map(({ v, i }) => (
            <li key={i} className={f.item}>
              <div className={f.head}>
                {i === versions.length - 1 ? "Сейчас" : i === 0 ? "Исходный текст" : `Правка ${i}`}
                <span>{formatWhen(v.at)}</span>
              </div>
              <div className={f.text}>
                {i === 0
                  ? v.text
                  : wordDiff(versions[i - 1].text, v.text).map((p, k) =>
                      p.kind === "same" ? (
                        p.text
                      ) : (
                        <span key={k} className={p.kind === "add" ? f.add : f.del}>
                          {p.text}
                        </span>
                      )
                    )}
              </div>
            </li>
          ))}
      </ol>
    </Dialog>,
    document.body
  );
}
