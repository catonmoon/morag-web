// Фильтры и сортировка списка записей — ЧИСТОЕ ядро, без DOM.
//
// Весь корпус приезжает одним ответом (188 записей — 156 КБ) и целиком лежит на клиенте,
// поэтому фильтрация мгновенная и без сервера. Здесь только состояние, отбор, сортировка и
// подсчёт фасетов; рисование — в `list.js`, чтобы это можно было проверить node-тестом.
//
// Фасеты у нас РАЗНОЙ ПРИРОДЫ, и обращение с ними разное:
//   раздел (4 значения) и год (5) — чипы, их видно все сразу;
//   подраздел — вторая ось выбранного раздела: у митапов это год (дубль, не показываем),
//   у курса — сам курс, и вот он единственная осмысленная ось;
//   метка (182 значения, 131 из них одноразовая) и спикер — чипами не выложить и списком не
//   спасти: включаются КЛИКОМ по метке на карточке, где они и так нарисованы.

/** Пустое состояние фильтров. `sort` пустой — «как решит раздел» (см. `sortFor`). */
export const EMPTY = { section: "", sub: "", year: "", category: "", topic: "", tag: "", speaker: "", kind: "", q: "", sort: "", view: "" };

/**
 * Измерения с МНОЖЕСТВЕННЫМ выбором (владелец, 14.09: «нельзя выбрать несколько категорий»):
 * значения внутри одного измерения соединяются ИЛИ, измерения между собой — И. В адресе и в
 * состоянии список хранится строкой через `|` — ключи и форма адреса не меняются, ссылка с
 * одним значением читается как раньше. Раздел, подраздел, год и человек остаются одиночными:
 * раздел и год — оси списка, а не признаки, и «два раздела разом» это просто «все разделы».
 */
export const MULTI = new Set(["category", "kind", "topic", "tag"]);
export const SEP = "|";
export const listOf = (value) => String(value || "").split(SEP).map((s) => s.trim()).filter(Boolean);
export const hasValue = (value, item) => listOf(value).includes(item);
/** Список с включённым или выключенным элементом — строкой, как хранится в состоянии. */
export function withValue(value, item, on) {
  const rest = listOf(value).filter((x) => x !== item);
  if (on) rest.push(item);
  return rest.join(SEP);
}

/** Все люди записи, какой бы ни была роль: по человеку ищут, не зная, выступал он или спрашивал. */
export const peopleOf = (record) => [...(record.speakers || []), ...(record.participants || [])];

export const SORTS = [
  { key: "new", label: "сначала свежие" },
  { key: "old", label: "сначала старые" },
  { key: "title", label: "по названию" },
  { key: "long", label: "сначала длинные" },
];

/** Число как число, а не как строка: «занятие-10» обязано идти после «занятие-2». */
const natural = (text) =>
  String(text).split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));

function naturalCmp(a, b) {
  const x = natural(a);
  const y = natural(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const l = x[i];
    const r = y[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    return typeof l === "number" && typeof r === "number" ? l - r : String(l) < String(r) ? -1 : 1;
  }
  return 0;
}

/** Всё, по чему ищет строка поиска. Заголовка мало: спрашивают и «кто», и «про что». */
const haystack = (record) =>
  [record.title, record.summary, ...peopleOf(record), ...(record.tags || []), ...(record.kind || []),
   record.category || "", ...(record.topics || [])]
    .join(" ")
    .toLowerCase();

/** Год записи: поле `year`, если корпус его дал (у курсов дата — дата выкладки), иначе из даты. */
const yearOf = (record) => record.year || String(record.date).slice(0, 4);

export function applyFilters(records, state) {
  const s = { ...EMPTY, ...state };
  const needle = s.q.trim().toLowerCase();
  const wanted = {};
  for (const dim of MULTI) wanted[dim] = listOf(s[dim]);
  return records.filter((r) => {
    if (s.section && r.section !== s.section) return false;
    // Подраздел — префикс пути: «Курсы» берёт и «Курсы/QA/2024/Неделя 03».
    if (s.sub && r.subgroup !== s.sub && !String(r.subgroup || "").startsWith(`${s.sub}/`)) return false;
    if (s.year && yearOf(r) !== s.year) return false;
    if (s.speaker && !peopleOf(r).includes(s.speaker)) return false;
    // Множественный выбор: хотя бы одно из выбранных значений измерения есть у записи.
    for (const dim of MULTI) {
      const want = wanted[dim];
      if (want.length && !valuesOf(r, dim).some((v) => want.includes(v))) return false;
    }
    if (needle && !haystack(r).includes(needle)) return false;
    return true;
  });
}

/**
 * Порядок по умолчанию для выбранного раздела.
 *
 * ⚠️ Курс читают ПОДРЯД, и «сначала свежие» показывает лекцию 25 первой. Направление приходит
 * с сервера (`reading.sections`) — из данных его не вывести: даты у лекций одинаковые, а
 * «читается как рассказ» это решение владельца, а не свойство записей.
 */
export function sortFor(state, reading = {}) {
  if (state.sort) return state.sort;
  const sections = reading.sections || {};
  const direction = state.section ? sections[state.section] : reading.default;
  // `title` — порядок курса по номеру в названии (content.order в site.yml).
  if (direction === "title") return "title";
  return direction === "asc" ? "old" : "new";
}

export function sortRecords(records, sort) {
  // Ничья по дате разрывается номером ПО ВОЗРАСТАНИЮ в обе стороны: у курса все занятия
  // выложены одним днём, то есть ничья там не редкий случай, а весь курс целиком.
  const out = [...records].sort((a, b) => naturalCmp(a.id, b.id));
  if (sort === "title") return out.sort((a, b) => naturalCmp(a.title, b.title));
  if (sort === "long") return out.sort((a, b) => (b.duration_sec || 0) - (a.duration_sec || 0));
  const sign = sort === "old" ? 1 : -1;
  return out.sort((a, b) => (a.date < b.date ? -sign : a.date > b.date ? sign : 0));
}

/**
 * Значения фасета и сколько записей за каждым — при ОСТАЛЬНЫХ действующих фильтрах.
 *
 * Считаем без своего измерения намеренно: иначе у выбранного чипа стоит его число, а у всех
 * соседних ноль, и переключиться становится некуда — фильтр выглядит сломанным.
 */
export function facet(records, state, dimension, reading = null) {
  const rest = { ...state, [dimension]: "" };
  const counts = new Map();
  for (const record of applyFilters(records, rest)) {
    for (const value of valuesOf(record, dimension)) {
      // Число на чипе — ровно то, что покажет список после щелчка (08.10, «статистика не
      // бьётся»): скрытое из общей ленты (`feed_hide`) считается, только если с этим значением
      // оно станет видно — выбор раздела его показывает, выбор года без раздела нет.
      if (reading && !inFeed(record, { ...state, [dimension]: value }, reading)) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return counts;
}

function valuesOf(record, dimension) {
  if (dimension === "year") return [yearOf(record)].filter(Boolean);
  if (dimension === "category") return [record.category].filter(Boolean);
  if (dimension === "topic") return record.topics || [];
  // Чипы второго ряда — только ПЕРВЫЙ уровень под веткой: глубже (поток, неделя) — дерево,
  // и сотня чипов «Курс/Поток/Неделя NN» была бы не осью, а свалкой.
  if (dimension === "sub") return [String(record.subgroup || "").split("/")[0]].filter(Boolean);
  if (dimension === "tag") return record.tags || [];
  if (dimension === "speaker") return peopleOf(record);
  if (dimension === "kind") return record.kind || [];
  return [record.section].filter(Boolean);
}

/**
 * Вторая ось выбранного раздела — и нужна она НЕ ВСЕГДА.
 *
 * У митапов подраздел это год, и показывать его рядом со строкой годов значит показать одно и
 * то же дважды. У курса подраздел — сам курс, и вот он единственная осмысленная ось: год там
 * бесполезен (все лекции выложены одним днём) и вдобавок врёт.
 */
export function subAxis(records, state) {
  if (!state.section) return [];
  const values = [...facet(records, { ...state, sub: "" }, "sub").keys()];
  if (!values.length || values.every((v) => /^\d{4}$/.test(v))) return [];
  return values.sort(naturalCmp);
}

/** Состояние из адреса. Ключи латиницей: русские в ссылке превращаются в частокол процентов. */
export function fromQuery(search) {
  const params = new URLSearchParams(search || "");
  const state = { ...EMPTY };
  for (const key of Object.keys(EMPTY)) state[key] = params.get(key) || "";
  return state;
}

/** Адрес из состояния: пустые ключи не пишем, иначе ссылка обрастает мусором. */
export function toQuery(state) {
  const params = new URLSearchParams();
  for (const key of Object.keys(EMPTY)) {
    const value = (state[key] || "").trim();
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const isEmpty = (state) => Object.keys(EMPTY).every((k) => !(state[k] || "").trim());

// --- оглавление -------------------------------------------------------------------------------
//
// Учебные ветки (курс ▸ поток ▸ неделя) читают по разделам, а не ищут по признаку: там список
// показывается ДЕРЕВОМ по каталогам, которое сворачивается (владелец, 08.10). Какие ветки —
// решает конфиг корпуса (`content.outline`); `view=cards` в адресе возвращает ленту.

/** Показывать ли выбранную ветку оглавлением. */
export const isOutline = (state, reading) =>
  !!state.section && state.view !== "cards" && (reading?.outline || []).includes(state.section);

/**
 * Общая лента (раздел не выбран, поиска нет) не показывает пути из `feed_hide`: сотня коротких
 * роликов одного курса, выложенных одним днём, заслонила бы всё остальное. В своей ветке и в
 * поиске они видны.
 */
export function inFeed(record, state, reading) {
  const hide = reading?.feed_hide || [];
  if (!hide.length || state.section || (state.q || "").trim()) return true;
  const path = [record.section, record.subgroup].filter(Boolean).join("/");
  return !hide.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Дерево ветки по пути подгруппы: `{name, path, count, sec, kids, leaves}`. Узлы — natural-
 * порядком («Неделя 2» до «Неделя 10»); занятия внутри узла — по названию так же. Если в узле
 * есть и подузлы, и свои занятия (организационное в корне потока), свои уходят в последний
 * подузел `rest` — иначе они висели бы вперемешку с неделями.
 */
export function outline(records, { rest = "Общее" } = {}) {
  const root = { name: "", path: "", kids: new Map(), leaves: [] };
  for (const record of records) {
    let node = root;
    for (const name of String(record.subgroup || "").split("/").filter(Boolean)) {
      const path = node.path ? `${node.path}/${name}` : name;
      if (!node.kids.has(name)) node.kids.set(name, { name, path, kids: new Map(), leaves: [] });
      node = node.kids.get(name);
    }
    node.leaves.push(record);
  }
  const finish = (node) => {
    const kids = [...node.kids.values()].sort((a, b) => naturalCmp(a.name, b.name)).map(finish);
    let leaves = [...node.leaves].sort(leafCmp);
    if (kids.length && leaves.length) {
      const path = node.path ? `${node.path}/\u0000${rest}` : `\u0000${rest}`;
      kids.push({ name: rest, path, rest: true, kids: [], leaves, ...sums(leaves) });
      leaves = [];
    }
    const own = sums(leaves);
    return {
      name: node.name, path: node.path, kids, leaves,
      count: own.count + kids.reduce((n, k) => n + k.count, 0),
      sec: own.sec + kids.reduce((s, k) => s + k.sec, 0),
    };
  };
  return finish(root);
}

/**
 * Порядок занятий в узле. Номер в начале ИМЕНИ ФАЙЛА — авторский порядок («1.Жизнь_QA_кто_мы»,
 * «2.…»): название его часто теряет, а сравнение названий тогда ставит «зачем мы» перед «кто
 * мы». Пронумерованные — по номеру и первыми, остальные — по названию.
 */
const fileNo = (r) => {
  const m = /^(\d+)/.exec(String(r.media || "").split("/").pop() || "");
  return m ? Number(m[1]) : Infinity;
};
function leafCmp(a, b) {
  const na = fileNo(a), nb = fileNo(b);
  if (na !== nb) return na - nb;
  return naturalCmp(a.title || a.id, b.title || b.id);
}

const sums = (leaves) => ({
  count: leaves.length,
  sec: leaves.reduce((s, r) => s + (r.duration_sec || 0), 0),
});
