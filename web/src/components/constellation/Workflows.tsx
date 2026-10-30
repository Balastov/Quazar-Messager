import { useCallback, useEffect, useState } from "react";
import {
  starsApi,
  type StarDetail,
  type StarForm,
  type StarWorkflow,
  type WorkflowBody,
  type WorkflowField,
  type WorkflowTrigger,
} from "../../api/stars";
import { formatWhen } from "../../chat/when";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";
import f from "./Workflows.module.css";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const TRIGGER_LABEL: Record<WorkflowTrigger, string> = {
  member_joined: "👋 Новый участник Звезды",
  schedule: "⏰ По расписанию",
  form: "📝 Форма заявки",
};

const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";

/** Готовые сценарии — с них удобно начать. */
function presets(channelId: string): { title: string; body: WorkflowBody }[] {
  return [
    {
      title: "Приветствие новичка",
      body: {
        name: "Приветствие",
        enabled: true,
        trigger: "member_joined",
        schedule: null,
        form: null,
        channel_id: channelId,
        text: "👋 Добро пожаловать в {star}, {user}!\n\n- Прочитайте правила в закреплённых\n- Расскажите о себе в паре строк\n- Вопросы — сюда, в этот Спутник",
      },
    },
    {
      title: "Заявка → карточка в канал",
      body: {
        name: "Заявка на доступ",
        enabled: true,
        trigger: "form",
        schedule: null,
        form: [
          { id: "system", label: "Система", kind: "select", required: true, options: ["VPN", "GitHub", "Jira", "Grafana"] },
          { id: "why", label: "Зачем нужен доступ", kind: "textarea", required: true, options: [] },
          { id: "until", label: "До какого числа", kind: "text", required: false, options: [] },
        ],
        channel_id: channelId,
        text: "",
      },
    },
    {
      title: "Стендап по понедельникам",
      body: {
        name: "Стендап",
        enabled: true,
        trigger: "schedule",
        schedule: { days: [1], time: "10:00", tz: browserTz() },
        form: null,
        channel_id: channelId,
        text: "☀️ **Стендап {date}**\n1. Что сделали на прошлой неделе?\n2. Что в планах на эту?\n3. Где нужна помощь?\n\nОтвечайте в ветке 👇",
      },
    },
  ];
}

function summary(wf: StarWorkflow, channelName: (id: string) => string): string {
  const where = `→ #${channelName(wf.channel_id)}`;
  if (wf.trigger === "schedule" && wf.schedule) {
    const days = wf.schedule.days.length === 5 && wf.schedule.days.every((d) => d <= 5)
      ? "по будням"
      : wf.schedule.days.map((d) => DAYS[d - 1]).join(", ");
    return `${days} в ${wf.schedule.time} ${where}`;
  }
  if (wf.trigger === "form") return `${wf.form?.length ?? 0} полей ${where}`;
  return `при входе в Звезду ${where}`;
}

/** Раздел «Сценарии» настроек Звезды. */
export function WorkflowsTab({ detail }: { detail: StarDetail }) {
  const satellites = detail.channels.filter((c) => c.kind === "satellite" && !c.shared_from);
  const [list, setList] = useState<StarWorkflow[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; body: WorkflowBody } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => setList(await starsApi.workflows(detail.id)), [detail.id]);
  useEffect(() => {
    void reload().catch((err) => setError(apiError(err)));
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await reload();
      if (done) setNotice(done);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const channelName = (id: string) => detail.channels.find((c) => c.id === id)?.name ?? "удалённый Спутник";
  const toBody = (wf: StarWorkflow): WorkflowBody => ({
    name: wf.name, enabled: wf.enabled, trigger: wf.trigger, schedule: wf.schedule, form: wf.form,
    channel_id: wf.channel_id, text: wf.text,
  });

  if (editing) {
    return (
      <WorkflowEditor
        detail={detail}
        initial={editing.body}
        busy={busy}
        error={error}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onSave={(body) =>
          void run(async () => {
            if (editing.id) await starsApi.updateWorkflow(detail.id, editing.id, body);
            else await starsApi.createWorkflow(detail.id, body);
            setEditing(null);
          })
        }
      />
    );
  }

  return (
    <div className={g.form}>
      <p className={s.hint}>
        Сценарий сам пишет в Спутник: встречает новичков, по расписанию задаёт вопрос для стендапа или превращает
        заполненную форму в карточку заявки. Формы участники открывают в «+» у поля сообщения.
      </p>
      {list?.map((wf) => (
        <div key={wf.id} className={w.hookCard}>
          <div className={s.row}>
            <b>{wf.name}</b>
            <span className={s.hint}>
              {TRIGGER_LABEL[wf.trigger]} · {summary(wf, channelName)}
            </span>
          </div>
          <span className={s.hint}>
            {!wf.enabled
              ? "Выключен"
              : wf.next_run_at
                ? `Следующий раз: ${formatWhen(wf.next_run_at)}`
                : wf.last_run_at
                  ? `Последний раз: ${formatWhen(wf.last_run_at)}`
                  : "Ещё не срабатывал"}
          </span>
          <div className={s.row}>
            <label className={g.check}>
              <input
                type="checkbox"
                checked={wf.enabled}
                disabled={busy}
                onChange={(e) => void run(() => starsApi.updateWorkflow(detail.id, wf.id, { ...toBody(wf), enabled: e.target.checked }))}
              />
              Включён
            </label>
            <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy} onClick={() => setEditing({ id: wf.id, body: toBody(wf) })}>
              Изменить
            </button>
            {wf.trigger !== "form" && (
              <button
                type="button"
                className={`${s.secondary} ${s.small}`}
                disabled={busy}
                onClick={() => void run(() => starsApi.testWorkflow(detail.id, wf.id), `Отправлено в #${channelName(wf.channel_id)}`)}
              >
                Проверить сейчас
              </button>
            )}
            <button
              type="button"
              className={`${s.danger} ${s.small}`}
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Удалить сценарий «${wf.name}»?`)) void run(() => starsApi.deleteWorkflow(detail.id, wf.id));
              }}
            >
              Удалить
            </button>
          </div>
        </div>
      ))}
      {list && list.length === 0 && <p className={s.hint}>Сценариев пока нет — начните с готового.</p>}
      {notice && <div className={s.hint}>✓ {notice}</div>}
      {error && <div className={s.error}>{error}</div>}

      <h4 className={w.sectionTitle}>Новый сценарий</h4>
      {satellites.length ? (
        <div className={f.presets}>
          {presets(satellites[0].id).map((p) => (
            <button key={p.title} type="button" className={f.preset} onClick={() => setEditing({ body: p.body })}>
              {TRIGGER_LABEL[p.body.trigger].split(" ")[0]} {p.title}
            </button>
          ))}
          <button
            type="button"
            className={f.preset}
            onClick={() =>
              setEditing({
                body: { name: "", enabled: true, trigger: "member_joined", schedule: null, form: null, channel_id: satellites[0].id, text: "" },
              })
            }
          >
            ✨ С нуля
          </button>
        </div>
      ) : (
        <p className={s.hint}>Сначала создайте Спутник — сценарии пишут в него.</p>
      )}
    </div>
  );
}

function WorkflowEditor({
  detail,
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  detail: StarDetail;
  initial: WorkflowBody;
  busy: boolean;
  error: string | null;
  onSave: (body: WorkflowBody) => void;
  onCancel: () => void;
}) {
  const satellites = detail.channels.filter((c) => c.kind === "satellite" && !c.shared_from);
  const [body, setBody] = useState<WorkflowBody>(initial);
  const set = (patch: Partial<WorkflowBody>) => setBody((b) => ({ ...b, ...patch }));
  const schedule = body.schedule ?? { days: [1, 2, 3, 4, 5], time: "10:00", tz: browserTz() };
  const fields = body.form ?? [];
  const setField = (i: number, patch: Partial<WorkflowField>) =>
    set({ form: fields.map((x, k) => (k === i ? { ...x, ...patch } : x)) });

  const changeTrigger = (trigger: WorkflowTrigger) =>
    set({
      trigger,
      schedule: trigger === "schedule" ? schedule : null,
      form: trigger === "form" ? (fields.length ? fields : [{ id: "f1", label: "Описание", kind: "textarea", required: true, options: [] }]) : null,
    });

  const vars =
    body.trigger === "form"
      ? ["{user}", "{name}", "{date}", ...fields.map((x) => `{${x.id}}`)]
      : body.trigger === "member_joined"
        ? ["{user}", "{name}", "{star}", "{date}"]
        : ["{star}", "{date}"];

  return (
    <div className={g.form}>
      <label className={s.label}>
        Название (подпись сообщений)
        <input className={s.input} value={body.name} maxLength={48} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className={s.label}>
        Когда
        <select className={s.select} value={body.trigger} onChange={(e) => changeTrigger(e.target.value as WorkflowTrigger)}>
          {(Object.keys(TRIGGER_LABEL) as WorkflowTrigger[]).map((t) => (
            <option key={t} value={t}>
              {TRIGGER_LABEL[t]}
            </option>
          ))}
        </select>
      </label>

      {body.trigger === "schedule" && (
        <div className={s.label}>
          Дни и время
          <div className={f.days}>
            {DAYS.map((d, i) => {
              const on = schedule.days.includes(i + 1);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  className={on ? `${f.day} ${f.dayOn}` : f.day}
                  onClick={() =>
                    set({
                      schedule: {
                        ...schedule,
                        days: on ? schedule.days.filter((x) => x !== i + 1) : [...schedule.days, i + 1].sort(),
                      },
                    })
                  }
                >
                  {d}
                </button>
              );
            })}
            <input
              type="time"
              className={s.input}
              style={{ width: 120 }}
              value={schedule.time}
              onChange={(e) => set({ schedule: { ...schedule, time: e.target.value } })}
            />
          </div>
          <span className={s.hint}>Часовой пояс: {schedule.tz}</span>
        </div>
      )}

      {body.trigger === "form" && (
        <div className={s.label}>
          Поля формы
          {fields.map((field, i) => (
            <div key={i} className={f.field}>
              <input
                className={s.input}
                value={field.label}
                maxLength={60}
                placeholder="Название поля"
                onChange={(e) => setField(i, { label: e.target.value })}
              />
              <select className={s.select} value={field.kind} onChange={(e) => setField(i, { kind: e.target.value as WorkflowField["kind"] })}>
                <option value="text">Строка</option>
                <option value="textarea">Текст</option>
                <option value="select">Список</option>
              </select>
              <label className={g.check}>
                <input type="checkbox" checked={field.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                обязательно
              </label>
              <button type="button" className={`${s.danger} ${s.small}`} onClick={() => set({ form: fields.filter((_, k) => k !== i) })}>
                ✕
              </button>
              {field.kind === "select" && (
                <input
                  className={`${s.input} ${f.options}`}
                  value={field.options.join(", ")}
                  placeholder="Варианты через запятую"
                  onChange={(e) => setField(i, { options: e.target.value.split(",").map((o) => o.trimStart()) })}
                />
              )}
              <span className={f.fieldId}>{`{${field.id}}`}</span>
            </div>
          ))}
          {fields.length < 10 && (
            <button
              type="button"
              className={`${s.secondary} ${s.small}`}
              onClick={() => {
                let n = fields.length + 1;
                while (fields.some((x) => x.id === `f${n}`)) n++;
                set({ form: [...fields, { id: `f${n}`, label: "", kind: "text", required: false, options: [] }] });
              }}
            >
              + Поле
            </button>
          )}
        </div>
      )}

      <label className={s.label}>
        Куда писать
        <select className={s.select} value={body.channel_id} onChange={(e) => set({ channel_id: e.target.value })}>
          {satellites.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </label>
      <label className={s.label}>
        {body.trigger === "form" ? "Текст карточки (пусто — соберём из полей)" : "Текст сообщения"}
        <textarea
          className={`${s.input} ${f.template}`}
          value={body.text}
          maxLength={4000}
          onChange={(e) => set({ text: e.target.value })}
        />
        <span className={s.hint}>Подстановки: {vars.join(" ")} · разметка как в сообщениях</span>
      </label>
      <label className={g.check}>
        <input type="checkbox" checked={body.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Включён
      </label>
      {error && <div className={s.error}>{error}</div>}
      <div className={s.row}>
        <button type="button" className={s.primary} disabled={busy || !body.name.trim()} onClick={() => onSave({ ...body, schedule: body.trigger === "schedule" ? schedule : null })}>
          Сохранить
        </button>
        <button type="button" className={s.secondary} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/** Заполнить форму сценария — карточка уйдёт в его Спутник. */
export function FormDialog({ detail, form, onClose }: { detail: StarDetail; form: StarForm; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = detail.channels.find((c) => c.id === form.channel_id);
  const ready = form.fields.every((x) => !x.required || values[x.id]?.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await starsApi.submitForm(detail.id, form.id, values);
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось отправить"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={form.name} onClose={onClose}>
      <div className={g.form}>
        {form.fields.map((field) => (
          <label key={field.id} className={s.label}>
            {field.label}
            {field.required ? " *" : ""}
            {field.kind === "textarea" ? (
              <textarea
                className={`${s.input} ${f.template}`}
                value={values[field.id] ?? ""}
                maxLength={1000}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
              />
            ) : field.kind === "select" ? (
              <select
                className={s.select}
                value={values[field.id] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
              >
                <option value="">— выберите —</option>
                {field.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={s.input}
                value={values[field.id] ?? ""}
                maxLength={1000}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <span className={s.hint}>Карточка появится в #{channel?.name ?? "Спутнике"}.</span>
        {error && <div className={s.error}>{error}</div>}
        <button type="button" className={s.primary} disabled={!ready || busy} onClick={() => void submit()}>
          Отправить
        </button>
      </div>
    </Dialog>
  );
}
