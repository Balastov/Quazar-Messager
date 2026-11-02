import { useEffect, useRef, useState } from "react";
import { useScreenAudio } from "../store/screenAudio";
import { useDevicesStore } from "../store/devices";
import { applyOutput } from "../calls/devices";
import { Amplifier, needsAmplifier } from "../calls/peerVolume";
import s from "./ScreenAudioControls.module.css";

/** Отдельная дорожка звука экрана в звонке 1:1 — микрофон идёт прежним плеером. */
export default function ScreenAudioPlayer({ stream }: { stream: MediaStream }) {
  const audio = useRef<HTMLAudioElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const amplifier = useRef<Amplifier | null>(null);
  const enabled = useScreenAudio((st) => st.enabled);
  const volume = useScreenAudio((st) => st.volume);
  const output = useDevicesStore((st) => st.output);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    element.srcObject = stream;
    return () => { amplifier.current?.close(); amplifier.current = null; element.srcObject = null; };
  }, [stream]);
  useEffect(() => {
    const element = audio.current, track = stream.getAudioTracks()[0];
    if (!element || !track || !container.current) return;
    let active = true;
    const gain = enabled ? volume : 0;
    if (gain > 0 && needsAmplifier(gain)) {
      amplifier.current ??= new Amplifier(track, container.current);
      amplifier.current.setVolume(gain);
      element.muted = true;
      void amplifier.current.play().then((ok) => { if (active) setBlocked(!ok); });
      void applyOutput(amplifier.current.output, output);
    } else {
      amplifier.current?.close(); amplifier.current = null;
      element.volume = gain; element.muted = !enabled || gain === 0;
    }
    void applyOutput(element, output);
    void element.play().then(() => { if (active && !amplifier.current) setBlocked(false); }).catch(() => { if (active) setBlocked(true); });
    return () => { active = false; };
  }, [stream, enabled, volume, output]);
  return <>
    <div ref={container} style={{ display: "none" }}><audio ref={audio} autoPlay playsInline muted /></div>
    {blocked && enabled && volume > 0 && <button type="button" className={s.unblock} onClick={() => {
      const plays = [audio.current?.play(), amplifier.current?.play()];
      void Promise.all(plays).then((results) => setBlocked(results.includes(false))).catch(() => setBlocked(true));
    }}>Включить звук трансляции в браузере</button>}
  </>;
}
