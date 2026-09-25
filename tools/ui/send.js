// Сцена 4: отправка пакета на сайт — список файлов с полосами и то, что делает сервер.
//
// Зачем отдельная сцена. Загрузка видео — это гигабайты по корпоративной сети, и она идёт дольше
// всей остальной отправки вместе взятой. До 25.09 в окне про неё не было НИЧЕГО: проценты
// печатались строками в свёрнутом логе (владелец: «при подтверждении загрузки видео на сайт тут
// уже надо показывать в браузере загрузку, сейчас она только в консоли»).
//
// ⚠️ Полос столько же, сколько файлов, и они НЕ исчезают по завершении: человек должен видеть, что
// уехало, а не только что едет сейчас. Общая полоса — по БАЙТАМ, а не по числу файлов: видео это
// 95 % веса пакета, и счёт «файл 4 из 5» стоял бы на месте всё время, которое действительно идёт.

import { el } from "./dom.js";

/** Человеческое имя файла: коллеге «artifact.json» не говорит ничего. */
const WHAT = {
  "artifact.json": "расшифровка",
  "voices.json": "отпечатки голосов",
  "slides.zip": "кадры экрана",
  "slides.pdf": "слайды",
  "record.slides.json": "экран записи",
  "record.refs.json": "обращения к экрану",
  "record.annotations.json": "аннотации",
};

/** Что делает сервер — его же словами, но по-русски. */
const SERVER = {
  accepted: "пакет принят, сервер собирает запись",
  uploading: "сервер принимает файлы",
  queued: "запись в очереди сборки",
  building: "сервер собирает запись",
  indexing: "сервер индексирует запись",
  done: "запись на сайте",
  error: "сервер не принял запись",
};

export function size(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} ГБ`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} МБ`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} КБ`;
  return `${n} Б`;
}

export function sendScene(root) {
  const head = el("p", { class: "tx-head" });
  const list = el("div", { class: "sn-list" });
  const note = el("p", { class: "fx-count" });
  root.append(head, list, note);
  // Сцена прячет себя САМА: разметка окна и стенда это тоже делает, но сцена не должна
  // зависеть от того, не забыли ли там `hidden`.
  root.setAttribute("hidden", "");

  const rows = new Map();     // имя файла → {bar, meta, row}
  let whole = 0;
  let moved = 0;
  let state = "";

  function label(name) {
    const what = WHAT[name] || (name.startsWith("video.") ? "видео" : name);
    return what === name ? name : `${what} · ${name}`;
  }

  function row(name, bytes) {
    const bar = el("i");
    const meta = el("span", { class: "sn-meta", text: size(bytes) });
    const node = el("div", { class: "sn-row" },
                    el("span", { class: "sn-name", text: label(name) }),
                    el("div", { class: "bar" }, bar), meta);
    rows.set(name, { node, bar, meta, bytes });
    list.append(node);
    return rows.get(name);
  }

  function begin(e) {
    root.removeAttribute("hidden");
    rows.clear();
    list.replaceChildren();
    whole = Number(e.bytes) || 0;
    moved = 0;
    for (const f of e.files || []) row(f.name, f.bytes);
    head.textContent = `отправляю пакет — ${(e.files || []).length} файлов, ${size(whole)}`;
    note.textContent = "";
  }

  function file(e) {
    root.removeAttribute("hidden");
    const it = rows.get(e.name) || row(e.name, e.bytes);
    const part = it.bytes > 0 ? Math.min(1, (Number(e.sent) || 0) / it.bytes) : (e.done ? 1 : 0);
    it.bar.style.width = `${Math.round(part * 100)}%`;
    it.node.classList.toggle("on", !e.done);
    it.node.classList.toggle("ok", Boolean(e.done));
    // Размер показываем ЦЕЛИКОМ, пока файл едет: «512 МБ из 1.2 ГБ» отвечает и на «сколько
    // осталось», и на «идёт ли вообще» — второй вопрос у больших файлов главный.
    it.meta.textContent = e.done ? size(it.bytes) : `${size(e.sent)} из ${size(it.bytes)}`;
    moved = Number(e.moved) || moved;
    whole = Number(e.whole) || whole;
    if (whole > 0) {
      head.textContent = `отправляю пакет — ${Math.round((moved / whole) * 100)} %`
        + ` (${size(moved)} из ${size(whole)}), файл ${e.i} из ${e.n}`;
    }
  }

  return {
    apply(e) {
      if (e.t === "upload.begin") { begin(e); return; }
      if (e.t === "upload.file") { file(e); return; }
      if (e.t === "upload.state") {
        root.removeAttribute("hidden");
        state = e.state || "";
        note.textContent = SERVER[state] || state;
        note.className = state === "error" ? "fx-count bad" : "fx-count";
        if (state === "error" && e.error) note.textContent += `: ${e.error}`;
        if (state === "done" && e.search === "later") {
          note.textContent += " · в поиске появится после ближайшей плановой индексации";
        }
      }
    },
    reset() {
      rows.clear();
      list.replaceChildren();
      head.textContent = "";
      note.textContent = "";
      whole = moved = 0;
      state = "";
      root.setAttribute("hidden", "");
    },
    state: () => ({ files: rows.size, moved, whole, server: state }),
  };
}
