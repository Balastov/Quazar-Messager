import {useEffect} from 'react';
import {AppState} from 'react-native';
import {useAuthStore} from '../store/auth';
import {useContactsStore} from '../store/contacts';

/**
 * Фоновая сверка телефонной книги: при входе и каждый раз, когда приложение снова
 * открывают, — если с прошлой сверки прошло больше SYNC_INTERVAL_MS.
 */
export default function ContactsAutoSync() {
  const userId = useAuthStore(st => st.user?.id);

  useEffect(() => {
    if (!userId) {
      return;
    }
    const store = useContactsStore.getState();
    void store.load().then(() => store.maybeSync());
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void useContactsStore.getState().maybeSync();
      }
    });
    return () => sub.remove();
  }, [userId]);

  return null;
}
