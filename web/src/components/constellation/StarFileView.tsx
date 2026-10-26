import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { starsApi, type StarFile } from "../../api/stars";
import { saveBytes } from "../../attachments/file";
import { detectImageMime, imageBlob } from "../../attachments/image";
import FileCard from "../messages/FileCard";
import ci from "../ChatImage.module.css";
import w from "./Work.module.css";

const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const urls = new Map<string, Promise<string>>();

/** Картинка из Спутника как blob: URL (тип — по самим байтам, не со слов отправителя). */
function loadPreview(starId: string, fileId: string): Promise<string> {
  let url = urls.get(fileId);
  if (!url) {
    url = starsApi.downloadFile(starId, fileId).then((bytes) => {
      const mime = detectImageMime(bytes);
      if (!mime) throw new Error("not an image");
      return URL.createObjectURL(imageBlob(bytes, mime));
    });
    url.catch(() => urls.delete(fileId));
    urls.set(fileId, url);
  }
  return url;
}

export async function downloadStarFile(starId: string, file: StarFile): Promise<void> {
  saveBytes(await starsApi.downloadFile(starId, file.id), file.name);
}

/** Файл в сообщении Спутника: картинка — превью (по нажатию — крупно), остальное — карточка. */
export default function StarFileView({ starId, file }: { starId: string; file: StarFile }) {
  const image = file.mime.startsWith("image/") && file.size <= PREVIEW_MAX_BYTES;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!image) return;
    let alive = true;
    loadPreview(starId, file.id)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [starId, file.id, image]);

  if (!image || failed) {
    return <FileCard name={file.name} size={file.size} onDownload={() => downloadStarFile(starId, file)} />;
  }
  return (
    <div className={w.filePreview}>
      <button type="button" className={ci.thumb} onClick={() => url && setOpen(true)} aria-label={`Открыть ${file.name}`} disabled={!url}>
        {url ? <img src={url} alt={file.name} className={w.previewImg} /> : <span className={ci.spinner} />}
      </button>
      <button type="button" className={w.previewName} onClick={() => void downloadStarFile(starId, file)} title="Скачать">
        ⬇ {file.name}
      </button>
      {open &&
        url &&
        createPortal(
          <div className={ci.lightbox} onClick={() => setOpen(false)} role="dialog" aria-label={file.name}>
            <img src={url} alt="" className={ci.full} />
          </div>,
          document.body
        )}
    </div>
  );
}
