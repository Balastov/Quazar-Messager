type IconProps = { className?: string; size?: number };

function Svg({
  size = 22,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconContacts = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);

export const IconCalls = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 18}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

export const IconPhone = (p: IconProps) => <IconCalls {...p} />;

export const IconVideo = (p: IconProps) => (
  <Svg {...p}>
    <path d="m23 7-7 5 7 5V7z" />
    <rect x="1" y="5" width="15" height="14" rx="2" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m21 16-5-5-9 9" />
  </Svg>
);

export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 19v3" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="m22 2-7 20-4-9-9-4 20-7z" />
  </Svg>
);

export const IconSticker = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12.5V8a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v8a5 5 0 0 0 5 5h4.5" />
    <path d="M21 12.5 12.5 21" />
    <path d="M21 12.5h-4a4.5 4.5 0 0 0-4.5 4.5v4" />
    <path d="M8.5 10h.01M14.5 10h.01" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 3 1.3" />
  </Svg>
);

/** Панель разметки текста. */
export const IconFormat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7V4h16v3" />
    <path d="M9 20h6" />
    <path d="M12 4v16" />
  </Svg>
);

export const IconStar = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 16}>
    <path d="m12 3 2.6 5.3L20.5 9l-4.2 4.1L17.4 20 12 17.1 6.6 20l1.1-6.9L3.5 9l5.9-.7L12 3z" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
);

export const IconAddressBook = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 18}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M12 7v6" />
    <path d="M9 10h6" />
  </Svg>
);

/** Созвездие: звёзды, соединённые линиями. */
export const IconConstellation = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 17 5-6 4 3 5-8" />
    <circle cx="5" cy="17" r="1.6" fill="currentColor" />
    <circle cx="10" cy="11" r="1.6" fill="currentColor" />
    <circle cx="14" cy="14" r="1.6" fill="currentColor" />
    <circle cx="19" cy="6" r="1.6" fill="currentColor" />
  </Svg>
);

/** Планета — голосовой канал. */
export const IconPlanet = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 18}>
    <circle cx="12" cy="12" r="5" />
    <path d="M4.5 15.5c-2 1.8-2.6 3.2-1.8 3.9 1.4 1.2 7-1.6 12.4-6.4S22.6 6 21.3 4.6c-.7-.8-2.2-.2-4 1.3" />
  </Svg>
);

/** Спутник — текстовый канал. */
export const IconSatellite = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 18}>
    <path d="M5 8h14M5 16h14M10 3 8 21M16 3l-2 18" />
  </Svg>
);

export const IconGear = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 18}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);

// --- Управление голосом на Планете (стиль Созвездия: тонкие линии и звёздочки-искорки) ---

/** Четырёхлучевая звёздочка-искорка с центром (cx, cy) и радиусом r. */
function Sparkle({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const k = r * 0.28;
  return (
    <path
      d={`M${cx} ${cy - r}L${cx + k} ${cy - k}L${cx + r} ${cy}L${cx + k} ${cy + k}L${cx} ${cy + r}L${cx - k} ${cy + k}L${cx - r} ${cy}L${cx - k} ${cy - k}Z`}
      fill="currentColor"
      stroke="none"
    />
  );
}

export const IconStarMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="3" width="6.5" height="11" rx="3.25" />
    <path d="M5 11.5a6.25 6.25 0 0 0 12.5 0" />
    <path d="M11.25 17.75V21" />
    <path d="M8.5 21h5.5" />
    <Sparkle cx={19.5} cy={4.5} r={2.3} />
  </Svg>
);

export const IconStarMicOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 9.5V6.25a3.25 3.25 0 0 0-6.2-1.36" />
    <path d="M8 8.5v2.25a3.25 3.25 0 0 0 5.1 2.67" />
    <path d="M5 11.5a6.25 6.25 0 0 0 10.4 4.67" />
    <path d="M17.5 11.5c0 .7-.1 1.4-.33 2" />
    <path d="M11.25 17.75V21" />
    <path d="M8.5 21h5.5" />
    <path d="M3.5 3.5l17 17" />
  </Svg>
);

/** Шумоподавление: «шумная» волна слева становится ровной линией, над ней искорка. */
export const IconNoiseFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 14c1.2-4 2.3-4 3.5 0s2.3 4 3.5 0 2.3-4 3.5 0" />
    <path d="M12.5 14h9" />
    <Sparkle cx={17.5} cy={7.5} r={3} />
  </Svg>
);

export const IconScreenShare = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
    <path d="M8.5 21h7" />
    <path d="M12 17v4" />
    <path d="M12 13.5V8" />
    <path d="M9.5 10.5L12 8l2.5 2.5" />
    <Sparkle cx={18} cy={7.5} r={1.6} />
  </Svg>
);

export const IconScreenStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
    <path d="M8.5 21h7" />
    <path d="M12 17v4" />
    <path d="M9.5 8l5 5M14.5 8l-5 5" />
  </Svg>
);

/** Устройства: наушники, а между чашками — маленькое созвездие. */
export const IconStarHeadphones = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="4.5" height="7" rx="2" />
    <rect x="16.5" y="14" width="4.5" height="7" rx="2" />
    <path d="M10 16.5l2-2 2 1.5" opacity="0.6" />
    <circle cx="10" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="12" cy="14.5" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="16" r="0.8" fill="currentColor" stroke="none" />
  </Svg>
);

/** Позвать: человек и звёздочка-«плюс». */
export const IconStarInvite = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20.5a6.5 6.5 0 0 1 13 0" />
    <Sparkle cx={18.5} cy={10} r={3.6} />
  </Svg>
);

/** Громкость собеседника: динамик и волны по уровню; 0 — перечёркнут, выше 100 % — искорка. */
export const IconStarVolume = ({ volume, ...p }: IconProps & { volume: number }) => (
  <Svg {...p}>
    <path d="M4 9.5h3l4.5-4v13l-4.5-4H4z" />
    {volume === 0 ? (
      <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
    ) : (
      <>
        <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
        {volume >= 0.5 && <path d="M17.5 7a7 7 0 0 1 0 10" />}
        {volume > 1 && <Sparkle cx={20.5} cy={4.5} r={2.3} />}
      </>
    )}
  </Svg>
);
