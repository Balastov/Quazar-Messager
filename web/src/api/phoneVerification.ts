import { http } from "./client";

export interface PhoneVerification {
  state: "pending" | "verified" | "expired" | "failed";
  phone: string;
  call_phone: string | null;
  expires_at: string;
  verification_token: string | null;
}
export const phoneVerificationApi = {
  start: (phone: string, account = false) => http.post<PhoneVerification>(
    account ? "/users/me/phone-verification/start" : "/auth/phone-verification/start", account ? {} : { phone },
  ).then(r => r.data),
  status: (token: string, account = false) => http.post<PhoneVerification>(
    account ? "/users/me/phone-verification/status" : "/auth/phone-verification/status", { verification_token: token },
  ).then(r => r.data),
};
