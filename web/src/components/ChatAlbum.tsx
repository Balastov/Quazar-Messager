import type { ImageRef } from "../attachments/image";
import ChatImage from "./ChatImage";
import s from "./ChatAlbum.module.css";

/**
 * Сколько из шести колонок сетки занимает каждая картинка: без пустых ячеек.
 * 2 и 4 — по две в ряд, 3 и 6 — по три, 5 — две сверху и три снизу.
 */
export function albumSpans(count: number): number[] {
  if (count === 5) return [3, 3, 2, 2, 2];
  const span = count === 2 || count === 4 ? 3 : 2;
  return Array.from({ length: count }, () => span);
}

/** Несколько картинок одного сообщения — сеткой; одна — как обычно, по своим пропорциям. */
export default function ChatAlbum({ chatId, images }: { chatId: string; images: ImageRef[] }) {
  if (images.length === 1) return <ChatImage chatId={chatId} image={images[0]} />;
  const spans = albumSpans(images.length);
  return (
    <div className={s.grid}>
      {images.map((image, i) => (
        <div key={image.id} className={s.cell} style={{ gridColumn: `span ${spans[i]}` }}>
          <ChatImage chatId={chatId} image={image} fill />
        </div>
      ))}
    </div>
  );
}
