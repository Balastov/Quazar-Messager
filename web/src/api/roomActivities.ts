import { http } from "./client";

export type BoardColor = "green" | "purple" | "amber" | "pink" | "blue" | "white";
export interface BoardPoint { x: number; y: number }
export interface BoardItem {
  id: string;
  revision: number;
  kind: "stroke" | "note" | "card";
  color: BoardColor;
  points: BoardPoint[];
  width: number;
  x: number;
  y: number;
  text: string;
  updated_by: string;
}
export type BoardItemBody = Omit<BoardItem, "id" | "updated_by">;
export interface FocusState {
  version: number;
  owner_id: string;
  phase: "work" | "break" | "done";
  running: boolean;
  work_seconds: number;
  break_seconds: number;
  remaining_seconds: number;
  ends_at: string | null;
}
export interface RoomVideo {
  id: string; name: string; mime: string; size: number; uploader_id: string | null; duration?: number | null;
}
export interface VideoState {
  version: number;
  owner_id: string;
  file_id: string | null;
  playing: boolean;
  position: number;
  duration?: number | null;
  updated_at: string;
  shared_controls: boolean;
}
export interface RoomSnapshot {
  star_id: string;
  channel_id: string;
  revision: number;
  server_time: string;
  pointers_sharer_id: string | null;
  focus: FocusState | null;
  video: VideoState | null;
  videos: RoomVideo[];
  board: BoardItem[];
}
export interface ScreenPointer {
  user_id: string; name: string; x: number; y: number; sharer_id: string; created_at: string;
}
export type RoomActivityEvent =
  | ({ type: "room_activity_state" } & Omit<RoomSnapshot, "board">)
  | { type: "room_board_item"; star_id: string; channel_id: string; item_id: string; item: BoardItem | null; revision: number }
  | { type: "room_board_reset"; star_id: string; channel_id: string; revision: number }
  | ({ type: "room_pointer"; star_id: string; channel_id: string } & ScreenPointer);

export type FocusAction = "start" | "pause" | "resume" | "stop" | "break";
export type VideoAction = "select" | "play" | "pause" | "seek" | "share" | "next" | "stop";
const base = (starId: string, channelId: string) => `/stars/${starId}/planets/${channelId}/activities`;

export const roomActivitiesApi = {
  get: (starId: string, channelId: string) => http.get<RoomSnapshot>(base(starId, channelId)).then((r) => r.data),
  pointers: (starId: string, channelId: string, enabled: boolean) =>
    http.put<RoomSnapshot>(`${base(starId, channelId)}/pointers`, { enabled }).then((r) => r.data),
  putItem: (starId: string, channelId: string, id: string, body: BoardItemBody) =>
    http.put<BoardItem>(`${base(starId, channelId)}/board/${id}`, body).then((r) => r.data),
  deleteItem: (starId: string, channelId: string, item: BoardItem) =>
    http.delete<{ revision: number }>(`${base(starId, channelId)}/board/${item.id}`, { params: { revision: item.revision } }).then((r) => r.data),
  clearBoard: (starId: string, channelId: string) =>
    http.delete<{ revision: number }>(`${base(starId, channelId)}/board`).then((r) => r.data),
  focus: (starId: string, channelId: string, action: FocusAction, version: number, workMinutes = 25, breakMinutes = 5) =>
    http.post<RoomSnapshot>(`${base(starId, channelId)}/focus`, {
      action, version, work_minutes: workMinutes, break_minutes: breakMinutes,
    }).then((r) => r.data),
  video: (starId: string, channelId: string, body: {
    action: VideoAction; version: number; file_id?: string; position?: number; duration?: number; shared_controls?: boolean;
  }) => http.post<RoomSnapshot>(`${base(starId, channelId)}/video`, body).then((r) => r.data),
  uploadVideo: async (starId: string, channelId: string, file: File, onProgress: (share: number) => void) => {
    const { readVideoDuration } = await import("../voice/videoMetadata");
    const duration = await readVideoDuration(file);
    return http.post<RoomSnapshot>(`${base(starId, channelId)}/videos`, file, {
      params: { name: file.name, duration }, headers: { "Content-Type": file.type },
      onUploadProgress: (e) => onProgress(e.total ? e.loaded / e.total : 0),
    }).then((r) => r.data);
  },
  deleteVideo: (starId: string, channelId: string, id: string) =>
    http.delete<RoomSnapshot>(`${base(starId, channelId)}/videos/${id}`).then((r) => r.data),
  videoBlob: (starId: string, channelId: string, id: string, signal: AbortSignal) =>
    http.get<Blob>(`${base(starId, channelId)}/videos/${id}`, { responseType: "blob", signal }).then((r) => r.data),
};
