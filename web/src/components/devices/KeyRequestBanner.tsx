import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WsEvent } from "../../api/types";
import { socket } from "../../ws/socket";
import Dialog from "../constellation/Dialog";
import { DeviceAuthorizer } from "./DeviceAuthorizer";

export type KeyRequest = Extract<WsEvent, { type: "device_key_request" }>;

export interface IncomingKeyRequest {
  request: KeyRequest | null;
  /** Пользователь согласился: это устройство подтверждает запрос. */
  open: boolean;
  setOpen(open: boolean): void;
  clear(): void;
}

/**
 * Запрос ключей от другого моего устройства. Пропадает, когда его занял другой экран или его отменили,
 * но не посреди подтверждения на этом устройстве.
 */
export function useIncomingKeyRequest(): IncomingKeyRequest {
  const [request, setRequest] = useState<KeyRequest | null>(null);
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const setOpen = useCallback((value: boolean) => { openRef.current = value; setOpenState(value); }, []);
  const clear = useCallback(() => { setOpen(false); setRequest(null); }, [setOpen]);
  useEffect(() => {
    const off = socket.on(event => {
      if (event.type === "device_key_request" && Date.parse(event.expires_at) > Date.now()) {
        if (!openRef.current) setRequest(event);
      } else if (event.type === "device_key_request_closed" && !openRef.current) {
        setRequest(current => current?.id === event.id ? null : current);
      }
    });
    return () => { off(); };
  }, []);
  // Истёкший запрос убираем, если его не начали подтверждать.
  useEffect(() => {
    if (!request || open) return;
    const timer = setTimeout(clear, Math.max(0, Date.parse(request.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [request, open, clear]);
  return { request, open, setOpen, clear };
}

/** Предложение передать ключи. Запрос занимается этим устройством только после «Передать ключи». */
export default function KeyRequestBanner({ incoming, classes }: {
  incoming: IncomingKeyRequest & { request: KeyRequest };
  classes: { banner: string; text: string; action: string; close: string };
}) {
  const { request, open, setOpen, clear } = incoming;
  if (open) return createPortal(
    <Dialog title="Передать ключи переписки" onClose={clear}>
      <DeviceAuthorizer key={request.id} link={{ kind: "request", id: request.id, key: request.receiver_public_key }} />
    </Dialog>,
    document.body,
  );
  return <div className={classes.banner} role="status">
    <span className={classes.text}>
      Устройство «{request.device_name}» просит ключи шифрования, чтобы читать личные сообщения.
    </span>
    <button type="button" className={classes.action} onClick={() => setOpen(true)}>Передать ключи</button>
    <button type="button" className={classes.close} aria-label="Скрыть" onClick={clear}>✕</button>
  </div>;
}
