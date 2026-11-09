import { useEffect, useState } from "react";
import type { StarDetail } from "../../api/stars";
import { CreateFloorForm, FLOOR_ACCESS_LABEL, FloorAccessForm } from "./FloorDialog";
import s from "./Constellation.module.css";

/** Настройки Звезды → «Доступ к этажам»: кому открыт каждый этаж карты офиса. */
export function FloorsTab({ detail }: { detail: StarDetail }) {
  const floors = [...detail.floors].sort((a, b) => a.position - b.position);
  const [floorId, setFloorId] = useState<string | null>(floors[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const floor = floors.find((f) => f.id === floorId) ?? floors[0];

  useEffect(() => {
    if (floorId && !floors.some((f) => f.id === floorId)) setFloorId(floors[0]?.id ?? null);
  }, [floors, floorId]);

  return (
    <div className={s.list}>
      <p className={s.hint}>
        Выберите этаж и отметьте, кому из участников он доступен. Без доступа участник не видит этаж
        и его Комнаты. Владелец, админы и те, кто редактирует карту офиса, видят все этажи.
      </p>
      <div className={s.floorTabs} role="tablist" aria-label="Этажи">
        {floors.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={!creating && f.id === floor?.id}
            className={!creating && f.id === floor?.id ? s.floorTabActive : s.floorTab}
            title={FLOOR_ACCESS_LABEL[f.access ?? "all"]}
            onClick={() => {
              setCreating(false);
              setFloorId(f.id);
            }}
          >
            {f.access === "none" ? "🔒 " : ""}
            {f.name}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={creating}
          className={creating ? s.floorTabActive : s.floorTab}
          onClick={() => setCreating(true)}
        >
          + Этаж
        </button>
      </div>
      {creating ? (
        <CreateFloorForm
          defaultName={`${floors.length + 1} этаж`}
          onCreated={(id) => {
            setFloorId(id);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : floor ? (
        <FloorAccessForm key={floor.id} detail={detail} floor={floor} />
      ) : (
        <span className={s.hint}>Этажей пока нет.</span>
      )}
    </div>
  );
}
