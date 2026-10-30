// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import EditHistory from "../../components/messages/EditHistory";

describe("история правок", () => {
  it("версии от новой к старой, отличия подсвечены", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(EditHistory, {
          current: { text: "релиз в пятницу вечером", at: "2026-10-31T10:05:00Z" },
          load: async () => [
            { text: "релиз в четверг", at: "2026-10-31T10:00:00Z" },
            { text: "релиз в пятницу", at: "2026-10-31T10:02:00Z" },
          ],
          onClose: () => {},
        })
      );
    });
    const items = [...document.body.querySelectorAll("li")];
    expect(items.map((li) => li.firstElementChild?.firstChild?.textContent)).toEqual(["Сейчас", "Правка 1", "Исходный текст"]);
    expect(items[1].querySelector("span[class*=del]")?.textContent).toBe("четверг");
    expect(items[1].querySelector("span[class*=add]")?.textContent).toBe("пятницу");
    expect(items[0].querySelector("span[class*=add]")?.textContent).toBe(" вечером");
    await act(async () => root.unmount());
  });
});
