import axios from "axios";
import { clientName } from "../platform/clientName";

export const http = axios.create({ baseURL: "/api", headers: { "X-Quazar-Client": clientName() } });

export function setAuthToken(token: string | null) {
  if (token) {
    http.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete http.defaults.headers.common["Authorization"];
  }
}
