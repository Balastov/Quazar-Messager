import { useEffect, useRef, useState } from "react";
import type { BoardColor, BoardItem, BoardItemBody, BoardPoint } from "../../api/roomActivities";
import { useRoomActivities, type RoomCache } from "../../store/roomActivities";
import { useAuthStore } from "../../store/auth";
import { BOARD_COLORS, boardPoint, wrapBoardText } from "./roomActivityMath";
import { apiError } from "./rules";
import s from "./RoomActivities.module.css";

type Tool = "pen" | "select" | "eraser";
const bodyOf = ({ id: _id, updated_by: _by, ...body }: BoardItem): BoardItemBody => body;

export default function RoomBoard({ starId, channelId, room, readOnly, canClear }: {
  starId: string; channelId: string; room: RoomCache; readOnly: boolean; canClear: boolean;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const { putItem, deleteItem, clearBoard } = useRoomActivities();
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<BoardColor>("green");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BoardItem | null>(null);
  const drag = useRef<{ pointerId: number; start: BoardPoint; item: BoardItem } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const items = Object.values(room.board).sort((a, b) => a.revision - b.revision);
  const selected = selectedId ? room.board[selectedId] : undefined;
  const mine = [...items].reverse().find((item) => item.updated_by === myId && item.kind === "stroke");
  useEffect(() => { setText(selected?.text ?? ""); if (selected) setColor(selected.color); }, [selectedId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (err) { setError(apiError(err, "Не удалось сохранить изменение доски")); }
    finally { setBusy(false); setDraft(null); }
  };
  const point = (event: React.PointerEvent<SVGSVGElement>) => boardPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
  const start = (event: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly || busy || event.button !== 0) return;
    const position = point(event);
    if (!position) return;
    const id = (event.target as Element).closest("[data-item]")?.getAttribute("data-item");
    const item = id ? room.board[id] : null;
    if (tool === "eraser") {
      if (item) void run(() => deleteItem(starId, channelId, item));
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (tool === "select") {
      setSelectedId(item?.id ?? null);
      if (item && item.kind !== "stroke") {
        drag.current = { pointerId: event.pointerId, start: position, item };
        setDraft(item);
      }
    } else {
      const item: BoardItem = { id: crypto.randomUUID(), revision: 0, kind: "stroke", color, width: 3,
        points: [position], x: 0, y: 0, text: "", updated_by: myId ?? "" };
      drag.current = { pointerId: event.pointerId, start: position, item };
      setDraft(item);
    }
  };
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const position = point(event);
    if (!position) return;
    if (active.item.kind === "stroke") {
      setDraft((item) => {
        if (!item || item.points.length >= 500) return item;
        const last = item.points[item.points.length - 1];
        if (Math.hypot(position.x - last.x, position.y - last.y) < 2) return item;
        return { ...item, points: [...item.points, position] };
      });
    } else {
      setDraft({ ...active.item, x: Math.max(0, Math.min(1000, active.item.x + position.x - active.start.x)),
        y: Math.max(0, Math.min(580, active.item.y + position.y - active.start.y)) });
    }
  };
  const finish = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!draft || (draft.kind === "stroke" && draft.points.length < 2)) { setDraft(null); return; }
    if (draft.kind !== "stroke" && draft.x === selected?.x && draft.y === selected?.y) { setDraft(null); return; }
    void run(() => putItem(starId, channelId, draft.id, bodyOf(draft)));
  };
  const addText = (kind: "note" | "card") => {
    if (!text.trim()) return;
    const item: BoardItemBody = { revision: 0, kind, color, points: [], width: 3,
      x: 40 + (items.length % 6) * 35, y: 40 + (items.length % 6) * 28, text: text.trim() };
    const id = crypto.randomUUID();
    void run(async () => { await putItem(starId, channelId, id, item); setSelectedId(id); setTool("select"); });
  };
  const download = () => {
    if (!svg.current) return;
    const clone = svg.current.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll("[data-preview], [data-selection]").forEach((node) => node.remove());
    clone.setAttribute("width", "1200"); clone.setAttribute("height", "700");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "quazar-board.svg";
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const draw = (item: BoardItem, preview = false) => (
    <g key={item.id} data-item={item.id} data-preview={preview || undefined}>
      <title>{item.text || "Линия"}</title>
      {item.kind === "stroke" ? <polyline points={item.points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none" stroke={BOARD_COLORS[item.color]} strokeWidth={item.width} strokeLinecap="round" strokeLinejoin="round" /> : <>
        <rect x={item.x} y={item.y} width="200" height="120" rx={item.kind === "note" ? 2 : 12}
          fill={item.kind === "note" ? BOARD_COLORS[item.color] : "#171323"} fillOpacity={item.kind === "note" ? 0.18 : 1}
          stroke={BOARD_COLORS[item.color]} strokeOpacity="0.75" />
        <clipPath id={`text-${item.id}`}><rect x={item.x + 10} y={item.y + 8} width="180" height="105" /></clipPath>
        <text x={item.x + 12} y={item.y + 22} fill="#f4f1ff" fontSize="14" fontFamily="sans-serif" clipPath={`url(#text-${item.id})`}>
          {wrapBoardText(item.text).slice(0, 5).map((line, i) => <tspan key={i} x={item.x + 12} dy={i ? 20 : 0}>{line}</tspan>)}
        </text>
      </>}
      {item.id === selectedId && item.kind !== "stroke" && <rect data-selection x={item.x - 3} y={item.y - 3}
        width="206" height="126" rx="4" fill="none" stroke="#f4f1ff" strokeDasharray="4 4" pointerEvents="none" />}
    </g>
  );
  return (
    <div className={s.board}>
      <div className={s.tools} role="toolbar" aria-label="Инструменты доски">
        {([ ["pen", "Рисовать"], ["select", "Выбрать / переместить"], ["eraser", "Ластик"] ] as const).map(([id, label]) =>
          <button key={id} type="button" className={tool === id ? s.activeButton : s.button} disabled={readOnly || busy}
            aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
        <label className={s.smallLabel}>Цвет <select value={color} onChange={(e) => setColor(e.target.value as BoardColor)}>
          {([ ["green", "Зелёный"], ["purple", "Фиолетовый"], ["amber", "Жёлтый"], ["pink", "Розовый"], ["blue", "Синий"], ["white", "Белый"] ] as const)
            .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button type="button" className={s.button} disabled={busy || readOnly || !mine}
          onClick={() => mine && void run(() => deleteItem(starId, channelId, mine))}>Отменить мой рисунок</button>
        <button type="button" className={s.button} disabled={busy || !!draft} onClick={download}>Скачать SVG</button>
        {canClear && <button type="button" className={s.danger} disabled={busy || readOnly || !items.length}
          onClick={() => { if (window.confirm("Очистить общую доску для всех участников?")) void run(() => clearBoard(starId, channelId)); }}>Очистить</button>}
      </div>
      <svg ref={svg} viewBox="0 0 1200 700" className={`${s.boardCanvas} ${tool === "pen" ? s.draw : ""}`}
        aria-label="Общая доска комнаты" tabIndex={0} onPointerDown={start} onPointerMove={move}
        onPointerUp={finish} onPointerCancel={() => { drag.current = null; setDraft(null); }}>
        <rect x="0" y="0" width="1200" height="700" fill="#0c0b14" />
        {items.filter((item) => item.id !== draft?.id).map((item) => draw(item))}
        {draft && draw(draft, true)}
      </svg>
      <div className={s.boardEditor}>
        <label className={s.smallLabel}>Объект <select value={selectedId ?? ""} onChange={(e) => { setSelectedId(e.target.value || null); setTool("select"); }}>
          <option value="">Новая заметка / карточка</option>
          {items.map((item, i) => <option key={item.id} value={item.id}>{item.text.slice(0, 35) || `Линия ${i + 1}`}</option>)}
        </select></label>
        <textarea className={s.textarea} value={text} maxLength={1000} disabled={readOnly || busy}
          placeholder="Текст заметки или карточки" aria-label="Текст заметки или карточки" onChange={(e) => setText(e.target.value)} />
        <div className={s.tools}>
          {selected && selected.kind !== "stroke" ? <button type="button" className={s.primary} disabled={busy || readOnly || !text.trim()}
            onClick={() => void run(() => putItem(starId, channelId, selected.id, { ...bodyOf(selected), text: text.trim(), color }))}>Сохранить текст</button> : <>
            <button type="button" className={s.button} disabled={busy || readOnly || !text.trim()} onClick={() => addText("note")}>Добавить заметку</button>
            <button type="button" className={s.button} disabled={busy || readOnly || !text.trim()} onClick={() => addText("card")}>Добавить карточку</button>
          </>}
          {selected && <button type="button" className={s.danger} disabled={busy || readOnly}
            onClick={() => void run(async () => { await deleteItem(starId, channelId, selected); setSelectedId(null); })}>Удалить объект</button>}
          {selected && <button type="button" className={s.button} onClick={() => { setSelectedId(null); setText(""); }}>Новый объект</button>}
        </div>
      </div>
      <p className={s.hint}>{busy ? "Сохраняем…" : "Изменения видны всем и сохраняются в комнате. Выберите заметку, чтобы передвинуть или изменить её."}</p>
      {error && <p role="alert" className={s.error}>{error}</p>}
    </div>
  );
}
