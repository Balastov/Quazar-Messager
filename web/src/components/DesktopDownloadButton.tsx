import { useContext } from "react";
import { MonitorDown, Smartphone } from "lucide-react";
import { DESKTOP_INSTALLERS } from "../platform/desktopDownloads";
import { DesktopDownloadContext } from "./DesktopDownloadContext";
import s from "./DesktopDownload.module.css";

export default function DesktopDownloadButton({ variant = "full" }: { variant?: "full" | "nav" }) {
  const context = useContext(DesktopDownloadContext);
  if (!context) return null;
  const phone = context.os === "mobile" || context.os === "android";
  const Icon = phone ? Smartphone : MonitorDown;
  const content = <><Icon size={variant === "nav" ? 22 : 19} aria-hidden /><span>{phone ? "Скачать мобильное приложение" : "Скачать десктоп версию"}</span></>;
  const className = variant === "nav" ? s.navButton : s.downloadButton;
  return context.os === "windows" ? <a className={className} href={DESKTOP_INSTALLERS.windows.url} target="_blank" rel="noopener noreferrer"
    title="Скачать тестовую версию Quazar для Windows x64" onClick={context.downloaded}>{content}</a>
    : <button type="button" className={className} onClick={context.open}>{content}</button>;
}
