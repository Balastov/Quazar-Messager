import { createContext } from "react";
import type { DownloadOS } from "../platform/desktopDownloads";

export interface DownloadsContext { os: DownloadOS; open(): void; downloaded(): void }
export const DesktopDownloadContext = createContext<DownloadsContext | null>(null);
