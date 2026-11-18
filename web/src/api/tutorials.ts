import { http } from "./client";

export type TourId = "main" | "stars" | "settings";
export type TourState = { state: "done" | "dismissed"; at: string };
export type TourProgress = Partial<Record<TourId, TourState>>;

export const tutorialsApi = {
  list: () => http.get<TourProgress>("/users/me/tutorials").then((r) => r.data),
  mark: (id: TourId, state: TourState["state"]) =>
    http.put<TourProgress>(`/users/me/tutorials/${id}`, { state }).then((r) => r.data),
};
