import axios from 'axios';

// Отладка: бэкенд на этом компьютере (в Android-эмуляторе 10.0.2.2 = localhost хоста;
// для iOS-симулятора и телефона по USB впишите IP компьютера).
// Релиз: боевой сервер — nginx отдаёт API под /api, WebSocket под /ws.
const DEV_HOST = '10.0.2.2:8000';
const PROD_HOST = 'quazar-msg.ru';

export const API_BASE_URL = __DEV__ ? `http://${DEV_HOST}` : `https://${PROD_HOST}/api`;
export const WS_BASE_URL = __DEV__ ? `ws://${DEV_HOST}` : `wss://${PROD_HOST}`;

export const http = axios.create({baseURL: API_BASE_URL});

export function setAuthToken(token: string | null) {
  if (token) {
    http.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete http.defaults.headers.common['Authorization'];
  }
}
