// Сцена 5: переслушивание — место, где модель сорвалась, слушается ещё раз.
//
// Самое зрелищное, что есть в конвейере: на глазах бессмыслица («ИИИИИИИ» на месте фразы)
// превращается в речь. Поэтому показываем парами «было → стало» и не прячем неудачи: там, где
// речи нет, стадия оставляет честную тишину, и это тоже надо видеть — иначе человек решит, что
// от него что-то скрыли.
//
// ⚠️ Показ не влияет на решение: события приходят ПОСЛЕ того, как стадия всё решила. Сцена только
// рисует, и её падение конвейеру безразлично.

import { clock, el } from "./dom.js";

// Исходы стадии — словами конвейера. Цвет несёт смысл: вернулась речь · честная тишина · не вышло.
const MARK = {
  "речь": { cls: "ok", say: "вернулась речь" },
  "коротко": { cls: "ok", say: "услышано короче" },
  "тишина": { cls: "hush", say: "тишина: речи там нет" },
  "петля осталась": { cls: "bad", say: "не вышло — оставили как было" },
  "без изменений": { cls: "hush", say: "без изменений" },
};

export function relistenScene(root) {
  const head = el("p", { class: "tx-head" });
  const list = el("div", { class: "rl-list" });
  const note = el("p", { class: "fx-count" });
  root.append(head, list, note);
  root.setAttribute("hidden", "");

  let seen = 0;
  const got = { "речь": 0, "коротко": 0, "тишина": 0, "петля осталась": 0, "без изменений": 0 };

  function row(e) {
    const mark = MARK[e.verdict] || { cls: "hush", say: e.verdict || "" };
    const at = `${clock(e.from)}–${clock(e.to)}`;
    return el("div", { class: `rl-row ${mark.cls}` },
      el("div", { class: "rl-head" },
         el("span", { class: "rl-at", text: at }),
         el("span", { class: "rl-verdict", text: mark.say })),
      // «Было» зачёркнуто той же линией, что и правка в тексте: приём один на всё окно.
      el("p", { class: "rl-was", text: e.was || "(пусто)" }),
      el("p", { class: "rl-now", text: e.now || "— тишина —" }));
  }

  function count() {
    const parts = [`переслушано ${seen}`];
    if (got["речь"] + got["коротко"]) parts.push(`вернулась речь в ${got["речь"] + got["коротко"]}`);
    if (got["тишина"]) parts.push(`тишина в ${got["тишина"]}`);
    if (got["петля осталась"]) parts.push(`не вышло в ${got["петля осталась"]}`);
    note.textContent = parts.join(" · ");
  }

  return {
    apply(e) {
      if (e.t === "client.step" && e.step === "relisten") {
        root.removeAttribute("hidden");
        head.textContent = "слушаю ещё раз места, где модель сорвалась";
        return;
      }
      if (e.t !== "relisten.span") return;
      root.removeAttribute("hidden");
      seen += 1;
      if (e.verdict in got) got[e.verdict] += 1;
      list.prepend(row(e));           // свежее сверху: человек смотрит на последнее
      while (list.children.length > 12) list.lastElementChild.remove();
      count();
    },
    reset() {
      seen = 0;
      for (const k of Object.keys(got)) got[k] = 0;
      list.replaceChildren();
      head.textContent = "";
      note.textContent = "";
      root.setAttribute("hidden", "");
    },
    state: () => ({ seen, ...got }),
  };
}
