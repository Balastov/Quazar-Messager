import {useEffect} from 'react';
import {AppState} from 'react-native';
import {socket} from '../ws/socket';
import {useCallStore} from '../store/call';

/** Столько приложение может быть в фоне, прежде чем станет «отошёл(ла)». */
export const BACKGROUND_AFTER_MS = 30_000;

/**
 * «В сети» / «отошёл»: приложение на экране — активен; в фоне дольше BACKGROUND_AFTER_MS
 * (свернули, погас экран) — неактивен; открыли снова — сразу активен.
 * Во время звонка — всегда активен: человек на встрече, экран может и погаснуть.
 */
export default function ActivityTracker() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const inCall = () => {
      const phase = useCallStore.getState().phase;
      return phase !== 'idle' && phase !== 'ended';
    };
    const apply = (state: string) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (state === 'active' || inCall()) {
        socket.setActivity('active');
      } else {
        timer = setTimeout(() => socket.setActivity('idle'), BACKGROUND_AFTER_MS);
      }
    };
    apply(AppState.currentState);
    const sub = AppState.addEventListener('change', apply);
    // Звонок закончился, а приложение в фоне — пересчитать.
    const unsubCall = useCallStore.subscribe(() => apply(AppState.currentState));
    return () => {
      sub.remove();
      unsubCall();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);
  return null;
}
