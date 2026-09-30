// Сцена 3: разбор экрана — кадр и то, что на нём увидели.
//
// Зачем показывать. Разбор экрана идёт минутами и до сих пор был в окне одной строкой «экран:
// описания кадров (Vision)». Хуже того, `describe_slides.py` возвращает УСПЕХ, если описан хотя
// бы один кадр: половина могла упасть, и человек об этом не узнавал вовсе. Здесь он видит и то,
// что разобрано, и то, что не далось.
//
// ⚠️ Кадр берём у СВОЕГО сервера (`/api/frame`), а не встраиваем в событие: картинка — это
// десятки килобайт, а событий за прогон тысячи, и лента событий обязана оставаться дешёвой.

import { clock, el } from "./dom.js";

export function screenScene(root, { frameUrl = null } = {}) {
  const head = el("p", { class: "tx-head" });
  const shot = el("div", { class: "sc-shot" });
  const side = el("div", { class: "sc-side" });
  const count = el("p", { class: "fx-count" });
  root.append(head, el("div", { class: "sc-row" }, shot, side), count);

  let done = 0;
  let finished = false;      // разбор экрана закончен — сцена спрятана
  let total = 0;
  let bad = 0;

  function show(e) {
    const failed = Boolean(e.error);
    if (failed) bad += 1;
    done = e.done || done + 1;
    total = e.n || total;
    // ⚠️⚠️ Адрес кадра строит ВЫЗЫВАЮЩИЙ: у локального сервера всё закрыто токеном из
    // адреса (иначе любая вкладка браузера читала бы файлы), а сцена токена не знает. Без
    // этого `<img>` получал 403 и рисовал битую иконку — молча (ловилось живьём 25.09).
    if (e.path && !failed && frameUrl) {
      shot.replaceChildren(el("img", { src: frameUrl(e.path), alt: "" }));
    } else if (failed) {
      shot.replaceChildren(el("p", { class: "sc-none", text: "кадр не разобрался" }));
    }
    side.replaceChildren(
      el("p", { class: "sc-kind", text: kindOf(e) }),
      el("p", { class: "sc-title", text: e.title || "" }),
      el("p", { class: failed ? "sc-text bad" : "sc-text", text: e.error || e.text || "" }));
    count.textContent = total
      ? `кадр ${done} из ${total}${bad ? ` · не далось ${bad}` : ""}`
      : `кадров ${done}${bad ? ` · не далось ${bad}` : ""}`;
  }

  function kindOf(e) {
    const known = { slide: "слайд", app: "окно программы", browser: "браузер",
                    terminal: "терминал", people: "люди в кадре", other: "экран" };
    // ⚠️ `sec` — секунда кадра В ЗАПИСИ; `at` у события занято временем прогона (см. `emit`).
    const at = Number.isFinite(e.sec) ? `${clock(e.sec)} · ` : "";
    return at + (known[e.kind] || (e.error ? "ошибка" : "экран"));
  }

  return {
    apply(e) {
      // Экран разобран — сцена уходит и отдаёт место тексту (владелец, 30.09): дальше смотреть
      // в ней нечего, а текст правится ещё долго.
      if (e.t === "client.step" && e.step === "screen" && e.done) {
        finished = true;
        root.setAttribute("hidden", "");
        return;
      }
      if (e.t === "client.step" && (e.step === "screen" || e.step === "slides")) {
        finished = false;
        root.removeAttribute("hidden");
        head.textContent = "разбираю экран — что было на мониторе в эту секунду";
        return;
      }
      if (e.t === "screen.frame") { if (!finished) root.removeAttribute("hidden"); show(e); }
    },
    reset() {
      done = total = bad = 0;
      finished = false;
      head.textContent = "";
      shot.replaceChildren();
      side.replaceChildren();
      count.textContent = "";
      root.setAttribute("hidden", "");
    },
    state: () => ({ done, total, bad }),
  };
}
