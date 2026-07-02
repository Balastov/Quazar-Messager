import axios from 'axios';

// Для Android эмулятора 10.0.2.2 = localhost хоста
// Для iOS симулятора и реального устройства — IP вашего компьютера
export const API_BASE_URL = 'http://10.0.2.2:8000';
export const WS_BASE_URL = 'ws://10.0.2.2:8000';

export const http = axios.create({baseURL: API_BASE_URL});

export function setAuthToken(token: string | null) {
  if (token) {
    http.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete http.defaults.headers.common['Authorization'];
  }
}
