import type { StarAsset } from "../../api/stars";
import StickerPicker from "../StickerPicker";

interface Props {
  assets: StarAsset[];
  onSticker: (text: string) => void;
  onEmoji: (code: string) => void;
  onClose: () => void;
}

/** The same emoji/sticker tabs as chats, including this Star's custom assets. */
export default function StarPicker({ assets, onSticker, onEmoji, onClose }: Props) {
  return <StickerPicker assets={assets} onEmoji={onEmoji} onClose={onClose}
    onPick={(pack, sticker) => onSticker(`STK1:${pack}/${sticker.id}`)}
    onStarSticker={asset => onSticker(`STK1:star/${asset.id}`)} />;
}
