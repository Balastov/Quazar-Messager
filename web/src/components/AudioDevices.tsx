import { useEffect } from "react";
import { useDevicesStore } from "../store/devices";
import s from "./AudioDevices.module.css";

/**
 * Выбор микрофона и динамика. «По умолчанию» — системное устройство.
 * Выбор запоминается на этом устройстве и сразу применяется к идущему разговору.
 */
export default function AudioDevices() {
  const {
    inputs,
    outputs,
    labelsHidden,
    input,
    output,
    outputSupported,
    iosRouteSupported,
    iosRoute,
  } = useDevicesStore();
  const { refresh, unlockLabels, setInput, setOutput, setIosRoute } = useDevicesStore.getState();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inputMissing = !!input && !inputs.some((d) => d.deviceId === input);
  const outputMissing = !!output && !outputs.some((d) => d.deviceId === output);

  return (
    <div className={s.root}>
      {labelsHidden && (
        <>
          <p className={s.hint}>
            Браузер покажет названия устройств после того, как вы разрешите доступ к микрофону.
          </p>
          <button type="button" className={s.button} onClick={() => void unlockLabels()}>
            Показать названия устройств
          </button>
        </>
      )}

      <label className={s.label}>
        Микрофон
        <select
          className={s.select}
          value={inputMissing ? "" : input}
          onChange={(e) => void setInput(e.target.value)}
        >
          <option value="">По умолчанию (системный)</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {inputMissing && (
        <p className={`${s.hint} ${s.warn}`}>
          Выбранный микрофон сейчас не подключён — используется системный.
        </p>
      )}

      {outputSupported ? (
        <>
          <label className={s.label}>
            Динамик
            <select
              className={s.select}
              value={outputMissing ? "" : output}
              onChange={(e) => void setOutput(e.target.value)}
            >
              <option value="">По умолчанию (системный)</option>
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {outputMissing && (
            <p className={`${s.hint} ${s.warn}`}>
              Выбранный динамик сейчас не подключён — звук идёт в системный.
            </p>
          )}
        </>
      ) : iosRouteSupported ? (
        <>
          <label className={s.label}>
            Звук собеседников
            <select
              className={s.select}
              value={iosRoute}
              onChange={(e) => setIosRoute(e.target.value as "speaker" | "receiver")}
            >
              <option value="speaker">Громкая связь</option>
              <option value="receiver">У уха (разговорный динамик)</option>
            </select>
          </label>
          <p className={s.hint}>
            Наушники и AirPods iPhone подключает сам. Если звук не переключился сразу — выйдите
            из разговора и зайдите снова.
          </p>
        </>
      ) : (
        <p className={s.hint}>
          Этот браузер не умеет выбирать динамик — звук идёт в системное устройство. Сменить его
          можно в настройках звука системы.
        </p>
      )}
    </div>
  );
}
