import w from "./Work.module.css";

const LOOK: Record<string, { label: string; bg: string; text: string }> = {
  github: { label: "GH", bg: "#24292f", text: "#fff" },
  gitlab: { label: "GL", bg: "#fc6d26", text: "#fff" },
  jira: { label: "J", bg: "#0052cc", text: "#fff" },
  grafana: { label: "G", bg: "#f46800", text: "#fff" },
  alertmanager: { label: "AM", bg: "#e6522c", text: "#fff" },
};

/** Значок интеграции вместо аватара (буквы и цвет сервиса). */
export default function BotAvatar({ kind }: { kind?: string | null }) {
  const look = (kind && LOOK[kind]) || { label: "⚙", bg: "rgba(168, 85, 247, 0.3)", text: "#fff" };
  return (
    <span className={w.botAvatar} style={{ background: look.bg, color: look.text }} aria-hidden>
      {look.label}
    </span>
  );
}
