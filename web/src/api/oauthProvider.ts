import { http } from "./client";

/** Параметры, с которыми клиент (Padma) открыл страницу авторизации. */
export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

/** Квазар как провайдер входа (docs/PADMA-SSO.md). */
export const oauthProviderApi = {
  /** Известен ли клиент и его адрес возврата: 200 { name } или 400. */
  client: (clientId: string, redirectUri: string) =>
    http.get<{ name: string }>("/oauth/client", { params: { client_id: clientId, redirect_uri: redirectUri } }).then(r => r.data),
  /** «Продолжить»: адрес возврата с одноразовым кодом. */
  authorize: (request: AuthorizeRequest) =>
    http.post<{ redirect_to: string }>("/oauth/authorize", request).then(r => r.data),
};
