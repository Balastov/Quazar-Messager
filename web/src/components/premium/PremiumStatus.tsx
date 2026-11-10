import type { PremiumState } from "../../api/types";
import { premiumStatus } from "./premiumText";
import s from "./Premium.module.css";

/** «Пробный Premium до 10 декабря 2026» — дата фирменным зелёным. */
export default function PremiumStatus({ state }: { state: PremiumState | null | undefined }) {
  const { text, until } = premiumStatus(state);
  return (
    <>
      {text}
      {until && (
        <>
          {" "}
          <span className={s.until}>{until}</span>
        </>
      )}
    </>
  );
}
