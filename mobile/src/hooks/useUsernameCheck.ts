import {useEffect, useState} from 'react';
import {authApi} from '../api/auth';
import {usernameProblem} from '../utils/profile';

export type UsernameCheck =
  | {state: 'idle'}
  | {state: 'checking'}
  | {state: 'ok'}
  | {state: 'bad'; message: string};

/** Никнейм при вводе: сначала правила локально, потом занятость на сервере (с задержкой).
 *  current — свой нынешний ник: он «свободен» в любом регистре. */
export function useUsernameCheck(value: string, current?: string): UsernameCheck {
  const [check, setCheck] = useState<UsernameCheck>({state: 'idle'});

  useEffect(() => {
    const name = value.trim().replace(/^@/, '');
    if (!name || (current && name === current)) {
      setCheck({state: 'idle'});
      return;
    }
    const problem = usernameProblem(name);
    if (problem) {
      setCheck({state: 'bad', message: problem});
      return;
    }
    if (current && name.toLowerCase() === current.toLowerCase()) {
      setCheck({state: 'ok'});
      return;
    }
    setCheck({state: 'checking'});
    let cancelled = false;
    const timer = setTimeout(() => {
      authApi
        .checkUsername(name)
        .then(r => {
          if (!cancelled) {
            setCheck(r.available ? {state: 'ok'} : {state: 'bad', message: r.reason ?? 'Никнейм недоступен'});
          }
        })
        // Сеть подвела — не мешаем: окончательно проверит сервер при сохранении.
        .catch(() => !cancelled && setCheck({state: 'idle'}));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, current]);

  return check;
}
