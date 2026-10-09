// Главная: плоский список записей с фильтрами.
//
// Список ПЛОСКИЙ и по убыванию даты (решение владельца 10.09). Раздел, подраздел, год, метка и
// спикер — это не заголовки, а ФИЛЬТРЫ: искать запись человек начинает с признака, а не с
// прокрутки дерева. Исключение — учебные ветки (`content.outline`, владелец 08.10): курс читают
// по разделам, и там список — оглавление-дерево по каталогам (см. «оглавление» ниже). Отбор и сортировка — в `filter.js`, чтобы их проверял node-тест; здесь
// только рисование и связь с адресом.
//
// ⚠️ Состояние фильтров живёт В АДРЕСЕ (`?section=…&year=…`). Иначе отфильтрованным видом
// нельзя поделиться, а возврат из записи кнопкой «назад» терял бы отбор — человек каждый раз
// начинал бы заново.
import { $, el, fmtDate, fmtDuration, countOf } from "../ui/dom.js";
import { paintSection } from "../ui/theme.js";
import { canvasMeasurer, hashSeed, layoutWords, letterMask } from "./letter-cloud.js";
import { drive as driveHalo, haloOptions, withoutShadow } from "../ui/halo.js";
import { coverUrl, getFrames, getRecords } from "../api.js";
import { fitBox } from "../ui/crop.js";
import {
  EMPTY, MULTI, SORTS, applyFilters, facet, fromQuery, hasValue, inFeed, isEmpty, isOutline, listOf,
  outline, sortFor, sortRecords, subAxis, withValue,
} from "./filter.js";

let loaded = null;
let state = { ...EMPTY };
let open = () => {};
// Куда вернуть прокрутку, придя назад из записи. Ключ — адрес с фильтрами: вернуться на
// прежнее место в ДРУГОМ отборе значит попасть в случайную точку чужого списка.
// `n` — сколько карточек было дорисовано: лента рисуется порциями, и вернуться на 120-ю карточку
// можно, только дорисовав до неё (иначе прокрутка упрётся в конец первой порции).
let scrollMemo = { key: "", y: 0, n: 0 };

export async function renderRecords({ onOpen }) {
  open = onOpen;
  const list = $("#rec-list");
  if (!loaded) {
    list.replaceChildren(el("div", { class: "rec-sub", text: "Загружаю записи…" }));
    loaded = await getRecords();
    mountControls();
  }
  state = fromQuery(location.search);
  $("#f-find").value = state.q;
  $("#filters").hidden = loaded.records.length < 2;
  paint({ restore: true });
}

/** Постоянные узлы — вешаются один раз: пересоздание отняло бы фокус у поля ввода. */
function mountControls() {
  const sort = $("#f-sort");
  sort.replaceChildren(...SORTS.map((s) => el("option", { value: s.key, text: s.label })));
  sort.addEventListener("change", () => set({ sort: sort.value }));
  // «› ещё фильтры» — текстовая кнопка, панель под строкой поиска (владелец, 14.09).
  // ⚠️ Сама НЕ раскрывается — только кнопкой (владелец, 15.09: «их много, пользователь
  // теряется»): после перезагрузки панель свёрнута, даже если в адресе выбрана тема или
  // метка, — число выбранного стоит на самой кнопке. Раньше раскрывалась по ссылке с таким
  // отбором, и человек, выбравший тему и обновивший страницу, снова получал всю панель.
  $("#f-more-btn").addEventListener("click", () => {
    moreOpen = !moreOpen;
    paint();
  });

  const find = $("#f-find");
  // `input`, а не `change`: список обязан сужаться по мере набора — иначе поиск по подстроке
  // ощущается как форма, которую надо «отправить».
  find.addEventListener("input", () => set({ q: find.value }, { keepFocus: true }));
}

/** Правка состояния: адрес, потом перерисовка. `replaceState` — чтобы «назад» уводил со
 *  страницы, а не отматывал по одному нажатому чипу. */
function set(patch, { keepFocus = false } = {}) {
  // Подраздел принадлежит разделу: сменили раздел — прежний курс к нему не относится.
  if ("section" in patch && patch.section !== state.section) patch = { ...patch, sub: "", view: "" };
  state = { ...state, ...patch };
  history.replaceState(history.state, "", location.pathname + query());  // state — глубина истории роутера
  paint({ keepFocus });
}

const query = () => {
  const params = new URLSearchParams();
  for (const key of Object.keys(EMPTY)) {
    const value = (state[key] || "").trim();
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

function paint({ restore = false, keepFocus = false } = {}) {
  const records = loaded.records;
  const sort = sortFor(state, loaded.reading);
  const matched = applyFilters(records, state);
  const shown = sortRecords(matched, sort).filter((r) => inFeed(r, state, loaded.reading));
  // Скрытое из общей ленты называем вслух — иначе сумма чипов разделов не бьётся со счётом.
  const hidden = matched.filter((r) => !inFeed(r, state, loaded.reading));
  // ⚠️ Селект обязан показывать ДЕЙСТВУЮЩИЙ порядок, а не только выбранный руками: выбрав
  // курс, список сам разворачивается к первой лекции, и «сначала свежие» в селекте было бы
  // прямой ложью о том, что человек видит.
  $("#f-sort").value = sort;

  chips($("#f-sections"), "section", facet(records, state, "section", loaded.reading), "все разделы");
  const subs = subAxis(records, state);
  const subsRow = $("#f-subs");
  subsRow.hidden = !subs.length;
  if (subs.length) chips(subsRow, "sub", facet(records, state, "sub", loaded.reading), "весь раздел", subs);
  paintMore(records);
  chips($("#f-years"), "year", facet(records, state, "year", loaded.reading), "все годы", null, true);
  active();

  const hours = Math.round(shown.reduce((sum, r) => sum + (r.duration_sec || 0), 0) / 3600);
  const where = [...new Set(hidden.map((r) => r.section).filter(Boolean))].map((s) => `«${s}»`).join(", ");
  $("#rec-count").textContent = shown.length
    ? `${countOf(shown.length, "запись", "записи", "записей")} · ${countOf(hours, "час", "часа", "часов")}`
      + (hidden.length ? ` · ещё ${hidden.length} — в разделе ${where}` : "")
    : "";

  const list = $("#rec-list");
  const tree = isOutline(state, loaded.reading);
  viewBar(tree, shown.length);
  if (!shown.length) list.replaceChildren(nothing());
  else if (tree) {
    list.dataset.painted = "0";
    list.replaceChildren(outlineView(shown));
  }
  else feed(list, shown, restore && memoMatches() ? scrollMemo.n : 0);

  if (keepFocus) $("#f-find").focus({ preventScroll: true });
  if (restore) restoreScroll();
}

// --- лента порциями ---------------------------------------------------------------------------
//
// Записей с видеолекциями — сотни (08.10), и рисовать все карточки разом с обложками незачем:
// человек видит первые два десятка. Рисуем порцию, следующую — когда страж внизу ленты подходит
// к экрану (автоподгрузка, а не страницы: страница сбрасывалась бы фильтром и требовала бы
// номера в адресе). Отбор, счётчики и сортировка — по ВСЕМ записям, порциями только DOM.
const CHUNK = 40;
let feedRun = 0;

function feed(list, shown, atLeast = 0) {
  const run = ++feedRun;                 // новая отрисовка отменяет стража прежней
  let painted = 0;
  const sentinel = el("div", { class: "rec-sentinel", "aria-hidden": "true" });
  const more = (want) => {
    if (run !== feedRun) return;
    const next = shown.slice(painted, Math.max(painted + CHUNK, want));
    painted += next.length;
    const nodes = next.map(card);
    sentinel.before(...nodes);
    markClampedNodes(nodes);
    list.dataset.painted = String(painted);
    if (painted >= shown.length) {
      observer.disconnect();
      sentinel.remove();
    }
  };
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) more(0);
  }, { rootMargin: "1200px 0px" });
  list.replaceChildren(sentinel);
  more(atLeast);
  if (sentinel.isConnected) observer.observe(sentinel);
}

// --- оглавление -------------------------------------------------------------------------------
//
// Учебная ветка — деревом по каталогам (курс ▸ поток ▸ неделя), узлы сворачиваются (владелец,
// 08.10). Содержимое свёрнутого узла не рисуется, пока его не раскрыли: в дереве сотни строк.
// Какие узлы открыты — помнит браузер (на устройство, не на всех); при поиске и фильтре дерево
// уже сужено отбором, и всё найденное раскрыто.
const OPEN_KEY = "morag.outline.open";
let openPaths = new Set(readOpen());

function readOpen() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"); } catch { return []; }
}
function saveOpen() {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openPaths])); } catch { /* без памяти */ }
}

function outlineView(shown) {
  const tree = outline(shown);
  const narrowed = PANEL_DIMS.some((d) => state[d]) || !!state.q.trim() || !!state.year || !!state.speaker;
  const box = el("div", { class: "outline" });
  paintSection(box, state.section);
  const kids = tree.kids.length ? tree.kids : [];
  // Узел первого уровня раскрыт по умолчанию — иначе ветка выглядит пустой строкой из трёх слов.
  box.append(...kids.map((k) => outlineNode(k, 0, narrowed)), ...tree.leaves.map(outlineLeaf));
  return box;
}

function outlineNode(node, depth, narrowed) {
  const opened = narrowed || openPaths.has(node.path) || (depth === 0 && !openPaths.has(`!${node.path}`));
  const details = el("details", { class: `ol-node${node.rest ? " ol-rest" : ""}` });
  const summary = el("summary", {},
    el("span", { class: "ol-name", text: node.name }),
    el("span", { class: "ol-sum", text: `${node.count} · ${fmtHours(node.sec)}` }));
  const body = el("div", { class: "ol-body" });
  details.append(summary, body);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    body.append(...node.kids.map((k) => outlineNode(k, depth + 1, narrowed)), ...node.leaves.map(outlineLeaf));
  };
  details.addEventListener("toggle", () => {
    if (details.open) fill();
    if (narrowed) return;                 // раскрытие найденного — не выбор человека, не запоминаем
    // У первого уровня по умолчанию «открыт», поэтому помним, что его ЗАКРЫЛИ («!путь»).
    if (depth === 0) {
      if (details.open) openPaths.delete(`!${node.path}`); else openPaths.add(`!${node.path}`);
    } else if (details.open) openPaths.add(node.path); else openPaths.delete(node.path);
    saveOpen();
  });
  if (opened) {
    fill();
    details.open = true;
  }
  return details;
}

function outlineLeaf(record) {
  const row = el("button", { class: "ol-leaf", type: "button", title: record.title },
    el("span", { class: "ol-play", text: "▶" }),
    el("span", { class: "ol-title", text: record.title }),
    record.duration_sec ? el("span", { class: "ol-dur", text: fmtDuration(record.duration_sec) }) : null);
  // Обложка — при наведении, всплывашкой: в строке ей места нет, а узнают занятие по слайду.
  if (record.cover) {
    row.addEventListener("mouseenter", () => {
      if (row.querySelector(".ol-cover")) return;
      row.append(el("img", { class: "ol-cover", src: coverUrl(record.id, record.cover), alt: "", loading: "lazy" }));
    }, { once: true });
  }
  row.addEventListener("click", () => {
    rememberScroll();
    open(record.id);
  });
  return row;
}

function fmtHours(sec) {
  const min = Math.round((sec || 0) / 60);
  return min >= 60 ? `${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, "0")} мин` : `${min} мин`;
}

/** Строка над списком у ветки-оглавления: «развернуть всё / свернуть всё» и «карточки». */
function viewBar(tree, count) {
  let bar = $("#rec-view");
  const can = !!state.section && (loaded.reading?.outline || []).includes(state.section);
  if (!bar) {
    bar = el("div", { class: "rec-view", id: "rec-view" });
    $("#rec-list").before(bar);
  }
  bar.hidden = !can || !count;
  if (bar.hidden) return;
  const btn = (text, title, fn) => {
    const b = el("button", { type: "button", class: "rec-view-btn", text, title });
    b.addEventListener("click", fn);
    return b;
  };
  const all = (open) => () => {
    for (const d of document.querySelectorAll("#rec-list details.ol-node")) d.open = open;
  };
  bar.replaceChildren(...[
    tree ? btn("развернуть всё", "Раскрыть все разделы", all(true)) : null,
    tree ? btn("свернуть всё", "Свернуть все разделы", all(false)) : null,
    btn(tree ? "карточками" : "оглавлением", tree ? "Показать лентой карточек" : "Показать деревом разделов",
      () => set({ view: tree ? "cards" : "" })),
  ].filter(Boolean));
}

// --- панель «ещё фильтры» --------------------------------------------------------------------
//
// Предмет и формат — чипы с МНОЖЕСТВЕННЫМ выбором (внутри измерения — ИЛИ), темы и метки —
// облака: кегль слова растёт с числом записей за ним (владелец, 14.09: «чем больше, тем крупнее
// шрифт, натуральное облако»). Порядок в облаке алфавитный, строки по центру — так крупные
// слова ложатся вразброс, и облако читается как облако, а не как список; найти слово при этом
// можно глазами, по алфавиту. Метки — 182 значения, 131 из них одноразовая: одноразовые
// спрятаны за «ещё N редких», иначе облако — простыня мелкого шрифта.
const PANEL_DIMS = ["category", "kind", "topic", "tag"];
let moreOpen = false;
let rareTags = false;

function paintMore(records) {
  const active = PANEL_DIMS.reduce((n, dim) => n + listOf(state[dim]).length, 0);
  const btn = $("#f-more-btn");
  btn.classList.toggle("on", moreOpen);
  btn.setAttribute("aria-expanded", String(moreOpen));
  // ⚠️ `replaceChildren` не пропускает null, а рисует текст «null» — отсеиваем до вставки.
  btn.replaceChildren(...[
    el("i", { text: moreOpen ? "⌄" : "›" }),
    ` ${moreOpen ? "скрыть фильтры" : "ещё фильтры"}`,
    active ? el("b", { text: String(active) }) : null,
  ].filter(Boolean));
  const panel = $("#f-more");
  panel.hidden = !moreOpen;
  if (!moreOpen) return;

  multiChips($("#f-cats"), "category", facet(records, state, "category", loaded.reading));
  multiChips($("#f-kinds"), "kind", facet(records, state, "kind", loaded.reading));
  // Темы — буква «М», метки — буква «О», рядом читаются как «МО» (владелец, 15.09); без
  // канваса (старый движок) — прежнее облако строками.
  letterCloud($("#f-topics"), "topic", facet(records, state, "topic", loaded.reading), "М");
  letterCloud($("#f-tags"), "tag", facet(records, state, "tag", loaded.reading), "О", { rareHidden: !rareTags, onRare: () => {
    rareTags = !rareTags;
    paint();
  } });
  for (const [block, box] of [["#fb-cats", "#f-cats"], ["#fb-kinds", "#f-kinds"], ["#fb-topics", "#f-topics"], ["#fb-tags", "#f-tags"]]) {
    $(block).hidden = !$(box).childElementCount;
  }
  alignLetters($("#f-topics"), $("#f-tags"));
}

/** Меньшая буква — на уровне СЕРЕДИНЫ большей (владелец, 29.09): с тех пор как буква растёт по
 *  числу слов, «М» и «О» бывают разного размера, и прижатая к верху меньшая смотрелась обрывком.
 *  Сдвигается само поле буквы, подписи блоков остаются наверху. Только когда буквы стоят в ОДНОМ
 *  ряду: на узком экране блоки идут друг под другом, и отступ был бы просто дырой. */
function alignLetters(...boxes) {
  for (const box of boxes) box.style.marginTop = "";
  if (!boxes.every((box) => box.classList.contains("lcloud") && !box.closest("[hidden]"))) return;
  const tops = boxes.map((box) => box.getBoundingClientRect().top);
  if (Math.abs(tops[0] - tops[1]) > 2) return;
  const heights = boxes.map((box) => box.offsetHeight);
  const tallest = Math.max(...heights);
  boxes.forEach((box, i) => {
    if (heights[i] < tallest) box.style.marginTop = `${Math.round((tallest - heights[i]) / 2)}px`;
  });
}

/** Чипы с множественным выбором: по убыванию частоты (у предметной оси нет «нового» и
 *  «старого»), выбранные всегда на месте — даже если при остальных фильтрах за ними ноль. */
function multiChips(row, dimension, counts) {
  const chosen = listOf(state[dimension]);
  const values = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1));
  for (const v of chosen) if (!values.includes(v)) values.push(v);
  row.replaceChildren(...values.map((value) => {
    const on = chosen.includes(value);
    return chip(value, counts.get(value) || 0, on, () => set({ [dimension]: withValue(state[dimension], value, !on) }));
  }));
}

/** Слова облака: вес 0..1 по логарифму числа записей, выбранные — всегда (даже при нуле),
 *  одноразовые метки — за «ещё N редких». Общее для облака строками и облака в форме буквы. */
function cloudEntries(dimension, counts, rareHidden) {
  const chosen = listOf(state[dimension]);
  let entries = [...counts.entries()];
  for (const v of chosen) if (!counts.has(v)) entries.push([v, 0]);
  const rare = rareHidden ? entries.filter(([v, n]) => n < 2 && !chosen.includes(v)) : [];
  if (rareHidden) entries = entries.filter(([v, n]) => n >= 2 || chosen.includes(v));
  entries.sort((a, b) => a[0].localeCompare(b[0], "ru"));
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const scale = (n) => (max <= 1 ? 0 : Math.log(Math.max(1, n)) / Math.log(max)); // 0..1
  return { chosen, entries, rare, weight: scale };
}

/** Кнопка-слово облака: кегль и яркость по весу, клик — фильтр. */
function cloudWord(dimension, value, n, w, on, extraClass = "", style = "") {
  const node = el("button", {
    class: `fcw${on ? " on" : ""}${extraClass}`, type: "button", text: value,
    title: n ? `${countOf(n, "запись", "записи", "записей")}` : "сейчас записей нет",
    style: `font-size:${(11 + 15 * w).toFixed(1)}px;--w:${w.toFixed(2)};${style}`,
  });
  node.addEventListener("click", () => set({ [dimension]: withValue(state[dimension], value, !on) }));
  return node;
}

/** Кнопка «ещё N редких…» / «скрыть редкие» — или null, если показывать нечего. */
function rareToggle(rare, entries, rareHidden, onRare) {
  if (!onRare) return null;
  if (rare.length) {
    const more = el("button", { class: "fcw fcw-rare", type: "button", text: `ещё ${countOf(rare.length, "редкая", "редкие", "редких")}…` });
    more.addEventListener("click", onRare);
    return more;
  }
  if (!rareHidden && entries.some(([, n]) => n < 2)) {
    const less = el("button", { class: "fcw fcw-rare", type: "button", text: "скрыть редкие" });
    less.addEventListener("click", onRare);
    return less;
  }
  return null;
}

/** Облако слов строками: кегль по логарифму числа записей (11-26 px), цвет от бледного к яркому. */
function cloud(box, dimension, counts, { rareHidden = false, onRare = null } = {}) {
  const { chosen, entries, rare, weight } = cloudEntries(dimension, counts, rareHidden);
  const nodes = entries.map(([value, n]) => cloudWord(dimension, value, n, weight(n), chosen.includes(value)));
  const toggle = rareToggle(rare, entries, rareHidden, onRare);
  if (toggle) nodes.push(toggle);
  box.classList.remove("lcloud");
  box.style.height = "";
  box.replaceChildren(...nodes);
}

/**
 * Облако в форме БУКВЫ (владелец, 15.09): слова разложены по маске глифа, часть — вертикально
 * и под углом, чтобы заполнились штрихи и буква читалась издалека. Геометрия — в
 * `letter-cloud.js`; здесь только слова, размер поля и кнопки. Поле квадратное; сторона буквы —
 * по площади слов (не больше ширины колонки), буква стоит по центру колонки.
 * Слова, которым не нашлось места, не пропадают: они дописываются строкой под буквой.
 */
function letterCloud(box, dimension, counts, letter, { rareHidden = false, onRare = null } = {}) {
  const width = Math.min(460, Math.max(240, box.clientWidth || 400));
  const root = getComputedStyle(document.documentElement);
  const serif = root.getPropertyValue("--serif").trim() || "Georgia, serif";
  const sans = root.getPropertyValue("--sans").trim() || "system-ui, sans-serif";
  // Обводка в 10 % стороны буквы: штрихи «М» и «О» жирнее самого жирного веса шрифта
  // (владелец, 15.09: «толщину букв тоже больше») — и площадь под слова заметно больше.
  const maskOf = (side) => letterMask(letter, { width: side, height: side, cell: 3, family: sans,
                                                stroke: Math.round(side * 0.1) });
  const measure = canvasMeasurer(serif);
  const probe = maskOf(120);
  if (!probe || !measure) return cloud(box, dimension, counts, { rareHidden, onRare });

  const { chosen, entries, rare, weight } = cloudEntries(dimension, counts, rareHidden);
  // Редкие (одноразовые) метки тоже идут в букву — последними и самым мелким кеглем: ими
  // добивается место, которое иначе осталось бы пустым (владелец, 29.09: «оттуда брать тоже»).
  // За «ещё N редких» остаются только те, что не влезли.
  const words = [
    ...entries.map(([value, n]) => ({ value, weight: weight(n), n })),
    ...rare.map(([value, n]) => ({ value, weight: 0, n, rare: true })),
  ];
  const byValue = new Map(words.map((w) => [w.value, w]));
  const seed = hashSeed(entries.map(([v, n]) => `${v}:${n}`));
  // Потолок кегля 22, не 26: замерено в странице на 91 теме — при 24 не влезают 13 слов,
  // при 22 четыре; крупные слова съедают площадь буквы быстрее, чем добавляют читаемости.
  const top = width < 360 ? 19 : 22;
  const MIN = 10;

  // ⚠️ Буква — ПО РАЗМЕРУ слов (владелец, 29.09). Была всегда полной, а слова рассыпались по
  // случайным клеткам маски: под фильтром от 91 темы оставалось полтора десятка, и они лежали
  // развалинами по огромной «М». Теперь сторона буквы считается от площади слов при их кегле:
  // слова остаются того же размера, а буква сжимается, пока они снова не лягут плотно и не
  // сложат форму. Доля клеток, которую занимает сам глиф, от размера не зависит (обводка — те
  // же 10 % стороны), поэтому её хватает померить на маленькой маске. FILL — какую часть
  // штрихов слова реально занимают при случайной раскладке; меньше — буква крупнее и рыхлее.
  // Крошечная буква рисуется всегда, даже из двух слов (решение владельца): не влезло — сторона
  // растёт шагами, до полной. Уже на полной — прежнее ужатие кегля; хвост под буквой — крайний случай.
  const FILL = 0.85;
  const glyph = probe.grid.reduce((sum, v) => sum + (v ? 1 : 0), 0) / probe.grid.length;
  let area = 0;
  for (const w of words) {
    const m = measure(w.value, MIN + (top - MIN) * w.weight);
    area += (m.w + 2) * (m.h + 2);
  }
  let side = Math.min(width, Math.max(80, Math.ceil(Math.sqrt(area / (glyph * FILL)))));
  let placed = [];
  let dropped = [];
  for (;;) {
    ({ placed, dropped } = layoutWords(maskOf(side), words, measure, { seed, minSize: MIN, maxSize: top }));
    if (!dropped.length || side >= width) break;
    side = Math.min(width, Math.ceil(side * 1.15));
  }
  // Не влезли все и на полной — потолок ужимается на два пункта и раскладка считается заново
  // (≈60 мс за проход): владелец просил, чтобы темы влезли в «М» ВСЕ.
  const lost = () => dropped.filter((v) => !byValue.get(v).rare);
  if (lost().length) {
    const full = maskOf(width);
    for (const cap of [top - 2, top - 4, top - 6]) {
      ({ placed, dropped } = layoutWords(full, words, measure, { seed, minSize: MIN, maxSize: cap }));
      if (!lost().length) break;
    }
  }
  // Меньшая буква — по центру своей колонки (владелец): «М» и «О» остаются парой.
  const shift = Math.max(0, ((box.clientWidth || width) - side) / 2);
  const height = side;
  placed = placed.map((p) => ({ ...p, x: p.x + shift }));
  const nodes = placed.map((p) => cloudWord(
    dimension, p.value, byValue.get(p.value).n, p.weight, chosen.includes(p.value), " lc",
    `left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px;font-size:${p.size.toFixed(1)}px;--rot:${p.angle}deg`,
  ));
  // Не влезло в букву — строкой под ней: слово из фильтра пропасть не может.
  const tail = lost().map((v) => cloudWord(dimension, v, byValue.get(v).n, byValue.get(v).weight, chosen.includes(v)));
  const rareLeft = rare.filter(([v]) => dropped.includes(v));
  const toggle = rareToggle(rareLeft, entries, rareHidden, onRare);
  const under = tail.length || toggle ? el("div", { class: "lc-under" }, ...tail, toggle) : null;
  box.classList.add("lcloud");
  box.style.height = `${height}px`;
  box.replaceChildren(...nodes);
  shimmer(box);
  // Хвост — соседом, а не внутрь: внутри поля всё абсолютно позиционировано.
  box.nextElementSibling?.classList.contains("lc-under") && box.nextElementSibling.remove();
  if (under) box.after(under);
}

// Слово под курсором переливается так же, как название сайта в шапке (владелец, 30.09: вместо
// магнита), и так же случайно: узор, палитра и цель — из `theme.halo`, при `pattern: random`
// на каждое наведение новые. `drive()` красит символы-ячейки `<i data-c data-r>`, поэтому на
// время наведения текст слова разбирается на ячейки (строка одна), а на уходе собирается обратно.
// Без свечения в обеих темах (владелец, 30.09): ореол размывает мелкие буквы облака.
// Слушатель один на поле буквы и переживает перерисовку: слова внутри меняются, поле — нет.
// Только для мыши: на тачскрине наведения нет.
const shimmering = new WeakSet();
function shimmer(box) {
  if (shimmering.has(box) || !matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
  if (matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  shimmering.add(box);
  let run = null;
  const stop = () => {
    if (!run) return;
    run.stop();
    run.word.textContent = run.text;
    run = null;
  };
  box.addEventListener("pointerover", (event) => {
    const word = event.target.closest?.(".fcw.lc");
    if (!word || word === run?.word) return;
    stop();
    const base = haloOptions();
    // Без конфига темы — всё равно случайно: сайт без `theme.halo` не должен терять эффект.
    const opts = base.pattern ? base : { pattern: "random", target: "random" };
    // Без свечения в ЛЮБОЙ теме (владелец, 30.09: «делает буквы размытыми»): у мелкого кегля
    // облака ореол размывает буквы, у крупного знака в шапке — нет. Ореол выпадает из пула,
    // остаётся подмена символов на гребне волны — буквы чёткие.
    const tuned = withoutShadow(opts);
    if (!tuned) return;
    const text = word.textContent;
    word.dataset.cols = String(text.length);
    word.dataset.rows = "1";
    word.replaceChildren(...[...text].map((ch, c) => {
      const cell = document.createElement("i");
      cell.dataset.c = String(c);
      cell.dataset.r = "0";
      cell.textContent = ch;
      return cell;
    }));
    run = { word, text, ...driveHalo(word, tuned) };
  });
  box.addEventListener("pointerout", (event) => {
    if (run && !run.word.contains(event.relatedTarget)) stop();
  });
}

/** Ряд чипов одного измерения. Ноль записей — чипа нет вовсе: выбор, ведущий в пустоту,
 *  выглядит поломкой. Выбранный остаётся всегда, иначе с него некуда вернуться.
 *
 *  ⓘ Без явного порядка чипы идут ПО СВЕЖЕСТИ: `facet` считает по списку, отсортированному по
 *  дате, и порядок ключей — это порядок первого появления. Алфавит поставил бы наверх раздел,
 *  где ничего не происходило годами. */
function chips(row, dimension, counts, allLabel, order = null, descending = false) {
  const values = order || (descending ? [...counts.keys()].sort((a, b) => (a < b ? 1 : -1))
                                      : [...counts.keys()]);
  const nodes = [chip(allLabel, "", !state[dimension], () => set({ [dimension]: "" }))];
  for (const value of values) {
    const count = counts.get(value) || 0;
    if (!count && state[dimension] !== value) continue;
    nodes.push(chip(value, count, state[dimension] === value, () =>
      set({ [dimension]: state[dimension] === value ? "" : value }),
      // Чип раздела — в цвете ветки: точка перед именем, выбранный заливается им.
      dimension === "section" ? value : ""));
  }
  row.replaceChildren(...nodes);
}

function chip(label, count, on, onClick, section = "") {
  const node = el(
    "button",
    { class: `fchip${on ? " on" : ""}`, type: "button" },
    el("span", { text: label }),
    count ? el("i", { text: String(count) }) : null
  );
  if (section) paintSection(node, section);
  node.addEventListener("click", onClick);
  return node;
}

/** Метка и спикер выбираются КЛИКОМ ПО КАРТОЧКЕ (их 182 и 16 — рядами не выложить),
 *  поэтому выбранное показываем отдельной строкой с крестиком: иначе непонятно, почему
 *  список короткий, и нечем это снять. */
function active() {
  const row = $("#f-active");
  const nodes = [];
  // ⓘ Подпись «спикер», а не «человек» (владелец, 14.09): измерение ищет и по выступавшим, и по
  // участникам, но на сайте эту ось называют спикером — так же подписан подстрочный поиск.
  for (const [dimension, prefix] of [["category", "предмет"], ["topic", "тема"], ["tag", "метка"], ["speaker", "спикер"], ["kind", "формат"]]) {
    // У измерений с множественным выбором — по чипу на значение, крестик снимает только его.
    const values = MULTI.has(dimension) ? listOf(state[dimension]) : [state[dimension]].filter(Boolean);
    for (const value of values) {
      const node = el(
        "button",
        { class: "fchip on drop", type: "button", title: `Снять фильтр: ${prefix}` },
        el("span", { text: `${prefix}: ${value}` }),
        el("i", { class: "x", text: "✕" })
      );
      node.addEventListener("click", () =>
        set({ [dimension]: MULTI.has(dimension) ? withValue(state[dimension], value, false) : "" }));
      nodes.push(node);
    }
  }
  if (!isEmpty(state)) {
    const reset = el("button", { class: "fchip reset", type: "button", text: "сбросить всё" });
    reset.addEventListener("click", () => {
      state = { ...EMPTY };
      $("#f-find").value = "";
      history.replaceState(history.state, "", location.pathname);
      paint();
    });
    nodes.push(reset);
  }
  row.hidden = !nodes.length;
  row.replaceChildren(...nodes);
}

// --- обложка со слайдшоу ---------------------------------------------------------------------
//
// Наведение на обложку через 2 с запускает пролистывание кадров записи (владелец, 14.09): по
// кадру в 1.4 с, по кругу; уход курсора возвращает обложку. Кадры — сырые `slides/sNNN.jpg`, в
// них есть полоса миниатюр участников и подпись говорящего (лица, фамилии), поэтому каждый кадр
// показывается через ТУ ЖЕ рамку, что вырезала обложку (`crop` из `/frames`, доли кадра):
// рамка у записи одна на все кадры — раскладка экрана в созвоне не меняется.
const SHOW_AFTER_MS = 2000;
const FRAME_MS = 1400;
const framesCache = new Map();

function fetchFrames(id) {
  if (!framesCache.has(id)) {
    framesCache.set(id, getFrames(id).catch(() => ({ frames: [], crop: null })));
  }
  return framesCache.get(id);
}

function coverWithSlideshow(record) {
  const img = el("img", { class: "rec-cover-img", src: coverUrl(record.id, record.cover), alt: "", loading: "lazy" });
  const wrap = el("div", { class: "rec-cover" }, img);
  let armed = null, ticker = null, i = 0, frames = [], crop = null, showing = false;
  // рамка применяется при загрузке КАЖДОГО кадра: натуральный размер известен только тогда;
  // слушатель один на обложку, а не на каждое наведение
  img.addEventListener("load", () => { if (showing && crop) fitBox(img, wrap, crop); });

  const restore = () => {
    clearTimeout(armed); clearInterval(ticker);
    armed = ticker = null;
    if (showing) {
      showing = false;
      img.removeAttribute("style");
      img.src = coverUrl(record.id, record.cover);
    }
  };
  const tick = () => {
    const f = frames[i++ % frames.length];
    img.src = coverUrl(record.id, f.frame);
    img.title = f.title || "";
  };
  const start = async () => {
    ({ frames, crop } = await fetchFrames(record.id));
    if (!frames.length || !armed) return;             // курсор уже ушёл — не стартуем
    showing = true;
    i = 0;
    tick();
    ticker = setInterval(tick, FRAME_MS);
  };
  wrap.addEventListener("mouseenter", () => { restore(); armed = setTimeout(start, SHOW_AFTER_MS); });
  wrap.addEventListener("mouseleave", () => { restore(); img.title = ""; });
  return wrap;
}

function nothing() {
  return el(
    "div",
    { class: "rec-empty" },
    el("b", { text: "Ничего не нашлось" }),
    el("span", { text: "Попробуйте снять часть фильтров или спросить у поиска вверху страницы." })
  );
}

// --- прокрутка --------------------------------------------------------------
//
// Уйти в запись и вернуться в начало списка из 188 карточек — это потерять место. Помним
// смещение и возвращаем его, но только если отбор тот же.

/** Свернуть «ещё фильтры» — зовёт знак в шапке: он значит «главная с чистого листа».
 *  Возврат из записи («К записям», «назад» браузера) панель НЕ трогает: там продолжают отбор. */
export function collapseFilters() {
  if (!moreOpen) return;
  moreOpen = false;
  if (loaded) paint();
}

export function rememberScroll() {
  const painted = Number($("#rec-list")?.dataset.painted || 0);
  scrollMemo = { key: location.pathname + location.search, y: window.scrollY, n: painted };
}

const memoMatches = () => scrollMemo.key === location.pathname + query() && scrollMemo.y > 0;

/** Забыть место: возвращаясь к ПОЛЮ ВОПРОСА (с диалога, по кнопке в шапке), человек не
 *  хочет попасть в середину списка, откуда когда-то открыл запись. */
export function forgetScroll() {
  scrollMemo = { key: "", y: 0, n: 0 };
}

function restoreScroll() {
  const key = location.pathname + query();
  if (scrollMemo.key !== key || !scrollMemo.y) return;
  const y = scrollMemo.y;
  // ⚠️ Одного кадра НЕ ХВАТАЕТ: замеряно — список уже в документе, но высота ещё нулевая, и
  // браузер обрезает прокрутку до нуля. Поэтому кладём несколько раз, форсируя пересчёт
  // высоты чтением, — тот же приём, что у читалки при переходе на момент.
  let touched = false;
  const stop = () => { touched = true; };
  for (const type of ["wheel", "touchmove", "keydown"]) {
    addEventListener(type, stop, { passive: true, once: true });
  }
  const put = () => {
    if (touched) return;              // человек уже листает сам — не дёргаем страницу
    void document.body.offsetHeight;  // форсируем пересчёт: без него scrollTo упрётся в ноль
    window.scrollTo(0, y);
  };
  requestAnimationFrame(put);
  setTimeout(put, 60);
  setTimeout(put, 250);
}

// --- карточка ---------------------------------------------------------------

/** «… ››» — только у обрезанных аннотаций. Обрезку решает раскладка (ширина колонки, длина
 * заголовка), поэтому меряем после отрисовки: сперва ЧТЕНИЕ у всех (один пересчёт раскладки на
 * 190 карточек), потом запись — иначе чтение-запись вперемешку пересчитывало бы её на каждой. */
function markClampedNodes(cards) {
  const nodes = cards.flatMap((c) => [...c.querySelectorAll(".rec-summary:not(.open)")]);
  const clipped = nodes.map((n) => n.scrollHeight > n.clientHeight + 1);
  nodes.forEach((n, i) => {
    const more = n.querySelector(".rec-more");
    if (more) more.hidden = !clipped[i];
  });
}

function card(record) {
  // На карточке — только ВЫСТУПАВШИЕ. Участники живут на странице записи: ведущий встречи
  // один и тот же на десятках карточек, и в списке это шум, а не признак.
  const speakers = (record.speakers || []).map((name) =>
    pick("speaker", name, "rec-who"));
  // Формат — чип перед темами: он же фильтр, кликом. Темы — из словаря корпуса, ПЕРВЫЕ ТРИ:
  // иначе карточка обрастёт, как с метками сайта (они остались в данных, но с витрины ушли —
  // 72% одноразовых и фамилии вместо тем; решение владельца 12.09).
  const kinds = (record.kind || []).map((kind) => pick("kind", kind, "chip-topic chip-kind"));
  const tags = (record.topics || []).slice(0, 3).map((topic) => pick("topic", topic, "chip-topic"));

  // Длительность — мелкий признак перед датой (владелец, 14.09): слева теперь обложка, а
  // «53 мин» рядом с датой читается как свойство записи, а не как её номер.
  const sub = el(
    "div",
    { class: "rec-sub" },
    record.duration_sec ? el("span", { class: "rec-dur", text: fmtDuration(record.duration_sec) }) : null,
    record.duration_sec ? el("span", { class: "dot" }) : null,
    fmtDate(record.date),
    speakers.length ? el("span", { class: "dot" }) : null,
    speakers.length ? el("span", { class: "rec-people" }, ...join(speakers)) : null,
    kinds.length || tags.length ? el("span", { class: "dot" }) : null,
    kinds.length || tags.length ? el("span", { class: "rec-topics" }, ...kinds, ...tags) : null,
    // Запись читается сразу, а в поиск попадает плановым прогоном (решение владельца 24.09:
    // не держать человека 20–40 минут после загрузки). Пока не попала — говорим об этом, иначе
    // «почему её не находит» выглядит поломкой поиска. Поле приходит, только если сервер вообще
    // знает, когда собирали индекс.
    record.indexed === false ? el("span", { class: "dot" }) : null,
    record.indexed === false
      ? el("span", { class: "rec-waiting", title: "Запись уже читается; в поиске появится после ближайшей индексации" },
          "ждёт индексации")
      : null
  );

  // Слева — ОБЛОЖКА, крупно, чтобы слайд читался (владелец, 14.09): кадр титульного слайда,
  // выбранный конвейером экрана (`cover` из сайдкара, уже обрезанный от миниатюр участников).
  // Где кадра нет (запись без видео или без слайдов) — нейтральная плашка того же размера, чтобы
  // список не разъезжался. В левой колонке у подкаста стоял номер выпуска, потом длительность —
  // она ушла к дате.
  const cover = record.cover ? coverWithSlideshow(record) : el("div", { class: "rec-cover rec-cover-none" });
  // Аннотация из поста, а где её нет — краткое содержание по расшифровке (`blurb`, тот же
  // текст, что на странице записи). Пустой строки не рисуем вовсе: список выглядел бы дырявым.
  // До пяти строк, дальше «… ››» разворачивает текст ПРЯМО НА КАРТОЧКЕ (владелец, 14.09) — не
  // уходя в запись. Кнопка показывается только у обрезанных: `markClamped` меряет после
  // отрисовки. Клик по ней не должен открывать запись — вся карточка ссылка.
  const summary = record.summary || record.blurb;
  const more = summary
    ? el("button", { class: "rec-more", type: "button", text: "… ››", title: "Показать весь текст", hidden: "" })
    : null;
  const summaryNode = summary ? el("div", { class: "rec-summary" }, el("span", { text: summary }), more) : null;
  more?.addEventListener("click", (event) => {
    event.stopPropagation();
    const opened = summaryNode.classList.toggle("open");
    more.textContent = opened ? "‹‹ свернуть" : "… ››";
    more.title = opened ? "Свернуть" : "Показать весь текст";
  });
  const node = el(
    "article",
    { class: "rec-card" },
    cover,
    el(
      "div",
      { class: "rec-main" },
      el("div", { class: "rec-title" },
        // Отметка «лучшее» из источника корпуса — знаком, без пояснений: смысл задаёт корпус.
        record.award ? el("span", { class: "rec-award", text: "🏆", title: "Отмечено" }) : null,
        record.title),
      summaryNode
    ),
    // Ни скачивания, ни стрелки «›» на карточке (владелец, 14.09): вся карточка — ссылка, а
    // расшифровку скачивают со страницы записи. Место — тексту.
    sub
  );
  // Цвет ветки — рамкой карточки и всем, что внутри неё нарисовано акцентом (длительность).
  paintSection(node, record.section);
  node.addEventListener("click", () => {
    rememberScroll();
    open(record.id);
  });
  return node;
}

/** Метка и спикер на карточке — они же фильтр. ⚠️ Клик обязан остановить всплытие: иначе он
 *  и отфильтрует список, и откроет запись, а человек увидит только второе. */
function pick(dimension, value, cls) {
  // У измерений с множественным выбором клик ДОБАВЛЯЕТ значение к выбранным, у одиночных —
  // заменяет; повторный клик снимает в обоих случаях.
  const multi = MULTI.has(dimension);
  const on = multi ? hasValue(state[dimension], value) : state[dimension] === value;
  const node = el("button", {
    class: `${cls} pick${on ? " on" : ""}`,
    type: "button",
    text: value,
    title: multi ? `Отобрать и это (${value})` : `Показать только это (${value})`,
  });
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    set({ [dimension]: multi ? withValue(state[dimension], value, !on) : on ? "" : value });
    window.scrollTo(0, 0);
  });
  return node;
}

// Запятая — обычный текстовый узел между кнопками. ⚠️ Зазор во флексе тут не годится: он
// отодвигает запятую от имени, и получается «Ковалёв , Кузнецова».
const join = (nodes) =>
  nodes.flatMap((node, i) => (i ? [document.createTextNode(", "), node] : [node]));
