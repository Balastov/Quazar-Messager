import { createPortal } from "react-dom";
import Dialog from "../constellation/Dialog";

/**
 * Окно поверх всего. Рисуется в body: окно чата со стеклом (backdrop-filter) становится
 * опорой для position: fixed, и окно внутри него не накрыло бы экран целиком.
 */
export default function ChatDialog(props: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return createPortal(<Dialog {...props} />, document.body);
}
